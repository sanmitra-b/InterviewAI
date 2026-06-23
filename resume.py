from dotenv import load_dotenv

load_dotenv()

import base64
import concurrent.futures
import io
import json
import os
import re
import tempfile
import time
from pathlib import Path

import cv2
from flask import Flask, jsonify, request
import numpy as np
import pdf2image
from PyPDF2 import PdfReader
from docx import Document

from body_language import _analyze_video_file
from body_language import _analyze_single_frame_metrics, PostureMetrics, summarize_metrics, PostureDetector
from practice_interview_service import (
    configure_gemini_if_available,
    evaluate_answer,
    extract_pdf_text,
    generate_content_with_failover,
    generate_interview_questions,
    has_any_gemini_api_key,
    save_interview_session,
)


app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024


# Runtime settings shared across resume/body endpoints.
LIVE_FRAME_DETECTORS = {}
LIVE_DETECTOR_LAST_SEEN = {}
LIVE_DETECTOR_IDLE_TIMEOUT_SEC = 90
RESUME_MODEL_TIMEOUT_SEC = 75
PDF_IMAGE_FALLBACK_MAX_PAGES = 2
GEMINI_KEY_MISSING_ERROR = "Gemini API key missing. Set GOOGLE_API_KEY_MAIN and GOOGLE_API_KEY_FALLBACK (or GOOGLE_API_KEY)."


def _cleanup_idle_live_detectors() -> None:
    # Release detector instances that have been idle beyond timeout.
    now = time.time()
    expired_ids = [
        session_id
        for session_id, last_seen in LIVE_DETECTOR_LAST_SEEN.items()
        if now - last_seen > LIVE_DETECTOR_IDLE_TIMEOUT_SEC
    ]

    for session_id in expired_ids:
        detector = LIVE_FRAME_DETECTORS.pop(session_id, None)
        LIVE_DETECTOR_LAST_SEEN.pop(session_id, None)
        if detector:
            detector.release()


def _frame_metrics_dict(metrics: PostureMetrics) -> dict:
    # Convert typed posture metrics to API-friendly dictionary shape.
    data = metrics.to_dict()
    data["status"] = "Good Body Language" if not metrics.issues else metrics.issues[0]
    data["excessive_looking_away_label"] = "Yes" if metrics.excessive_looking_away else "No"
    return data


def _encode_frame_jpeg(frame: np.ndarray) -> str:
    # Encode OpenCV frame to base64 JPEG for client-side preview overlays.
    success, encoded = cv2.imencode(".jpg", frame)
    if not success:
        return ""
    return base64.b64encode(encoded.tobytes()).decode("utf-8")


@app.after_request
def add_cors_headers(response):
    # Allow browser clients to call API from local static server origin(s).
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


configure_gemini_if_available()


# Prompt templates and response parsing utilities.
def get_prompts(mode: str):
    # Return strict JSON-only prompt schema based on analysis mode.
    if mode == "match":
        return """
Return ONLY valid JSON:
{"percentage": int, "missing_keywords": [str], "strengths": [str], "feedback": str}
Rules: percentage 0-100, missing_keywords <= 8, strengths <= 5, concise feedback, no markdown.
"""

    return """
Return ONLY valid JSON:
{"rating": number, "strengths": [str], "weaknesses": [str], "feedback": str}
Rules: rating 0-10, strengths <= 5, weaknesses <= 5, concise feedback, no markdown.
"""


def extract_resume_data(uploaded_file):
    # Parse resume content from PDF/DOCX, with PDF image fallback when text extraction fails.
    if uploaded_file is None:
        raise FileNotFoundError("No file uploaded")

    file_name = uploaded_file.filename.lower()

    if file_name.endswith(".pdf"):
        pdf_bytes = uploaded_file.read()

        try:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            text_parts = []
            for idx, page in enumerate(reader.pages):
                page_text = page.extract_text() or ""
                if page_text.strip():
                    text_parts.append(f"--- Page {idx + 1} ---\n{page_text}")
            if text_parts:
                return "\n\n".join(text_parts)
        except Exception:
            pass

        try:
            images = pdf2image.convert_from_bytes(
                pdf_bytes,
                first_page=1,
                last_page=PDF_IMAGE_FALLBACK_MAX_PAGES,
            )
            image_parts = []
            for image in images:
                image_buffer = io.BytesIO()
                image.save(image_buffer, format="JPEG")
                image_parts.append(
                    {
                        "mime_type": "image/jpeg",
                        "data": base64.b64encode(image_buffer.getvalue()).decode("utf-8"),
                    }
                )
            return image_parts
        except Exception as exc:
            raise FileNotFoundError(f"Failed to process PDF: {exc}") from exc

    if file_name.endswith(".docx"):
        try:
            document = Document(io.BytesIO(uploaded_file.read()))
            paragraphs = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
            text_content = "\n".join(paragraphs)
            if text_content:
                return text_content
            raise ValueError("The DOCX file appears empty or has no readable text.")
        except Exception as exc:
            raise FileNotFoundError(f"Failed to process DOCX: {exc}") from exc

    raise ValueError("Unsupported file type. Please upload a PDF or DOCX file.")


def get_gemini_response(instruction, resume_data, job_description):
    # Build Gemini content payload (text or image parts) and return raw text response.
    job_text = job_description or "No job description provided."

    if isinstance(resume_data, str):
        content = [instruction, "Resume:\n" + resume_data, "Job Description:\n" + job_text]
    else:
        content = [instruction, "Analyze this resume:"] + resume_data + ["Job Description:\n" + job_text]

    response = generate_content_with_failover("gemini-2.5-flash-lite", content)
    return response.text or "{}"


def get_gemini_response_with_timeout(instruction, resume_data, job_description, timeout_sec=RESUME_MODEL_TIMEOUT_SEC):
    # Guard model call with timeout to keep API latency bounded.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(get_gemini_response, instruction, resume_data, job_description)
        try:
            return future.result(timeout=timeout_sec)
        except concurrent.futures.TimeoutError as exc:
            raise TimeoutError("Resume analysis timed out. Please try again.") from exc


def _extract_json_block(text: str) -> str:
    # Extract first JSON object, supporting fenced markdown and free-form output.
    cleaned = (text or "").strip()

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
    if fenced:
        return fenced.group(1)

    first = cleaned.find("{")
    last = cleaned.rfind("}")
    if first != -1 and last != -1 and last > first:
        return cleaned[first:last + 1]

    return cleaned


def parse_response(raw_text: str, mode: str):
    # Parse model output into stable frontend response schema with regex fallback.
    parsed = None
    try:
        parsed = json.loads(_extract_json_block(raw_text))
    except Exception:
        parsed = None

    if mode == "match":
        if not isinstance(parsed, dict):
            percent_match = re.search(r"(\d{1,3})\s*%", raw_text or "")
            return {
                "percentage": int(percent_match.group(1)) if percent_match else 0,
                "missing_keywords": [],
                "strengths": [],
                "feedback": raw_text.strip() if raw_text else "No feedback generated.",
            }

        return {
            "percentage": int(parsed.get("percentage", 0)),
            "missing_keywords": parsed.get("missing_keywords", []) or [],
            "strengths": parsed.get("strengths", []) or [],
            "feedback": parsed.get("feedback", "") or "",
        }

    if not isinstance(parsed, dict):
        rating_match = re.search(r"(\d+(?:\.\d+)?)\s*/\s*10", raw_text or "")
        rating = float(rating_match.group(1)) if rating_match else 0.0
        return {
            "rating": rating,
            "strengths": [],
            "weaknesses": [],
            "feedback": raw_text.strip() if raw_text else "No feedback generated.",
        }

    return {
        "rating": float(parsed.get("rating", 0)),
        "strengths": parsed.get("strengths", []) or [],
        "weaknesses": parsed.get("weaknesses", []) or [],
        "feedback": parsed.get("feedback", "") or "",
    }


@app.route("/health", methods=["GET"])
def health():
    # Lightweight API health endpoint used by clients and debugging.
    return jsonify({"status": "ok", "services": ["resume", "body-language"]})


# CORS preflight handlers.
@app.route("/scan-resume", methods=["OPTIONS"])
def scan_resume_options():
    return ("", 204)


@app.route("/upload-resume", methods=["OPTIONS"])
def upload_resume_options():
    return ("", 204)


@app.route("/generate-questions", methods=["OPTIONS"])
def generate_questions_options():
    return ("", 204)


@app.route("/evaluate-answer", methods=["OPTIONS"])
def evaluate_answer_options():
    return ("", 204)


@app.route("/save-session", methods=["OPTIONS"])
def save_session_options():
    return ("", 204)


@app.route("/analyze-body", methods=["OPTIONS"])
def analyze_body_options():
    return ("", 204)


@app.route("/end-body-session", methods=["OPTIONS"])
def end_body_session_options():
    return ("", 204)


# Resume analysis and interview-practice endpoints.
@app.route("/scan-resume", methods=["POST"])
def scan_resume():
    # Analyze resume in either review mode (rating) or match mode (percentage).
    if not has_any_gemini_api_key():
        return jsonify({"error": GEMINI_KEY_MISSING_ERROR}), 500

    uploaded_file = request.files.get("resume")
    if not uploaded_file:
        return jsonify({"error": "Missing resume file."}), 400

    mode = (request.form.get("type") or "review").strip().lower()
    if mode not in {"review", "match"}:
        return jsonify({"error": "Invalid type. Use 'review' or 'match'."}), 400

    job_description = request.form.get("job_description", "")

    try:
        resume_data = extract_resume_data(uploaded_file)
        prompt = get_prompts(mode)
        raw_response = get_gemini_response_with_timeout(prompt, resume_data, job_description)
        result = parse_response(raw_response, mode)
        return jsonify(result)
    except TimeoutError as exc:
        return jsonify({"error": str(exc)}), 504
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/upload-resume", methods=["POST"])
def upload_resume():
    # Extract and return plain resume text used by interview-question generation.
    if not has_any_gemini_api_key():
        return jsonify({"error": GEMINI_KEY_MISSING_ERROR}), 500

    uploaded_file = request.files.get("resume")
    if not uploaded_file:
        return jsonify({"error": "Missing resume file."}), 400

    try:
        resume_text = extract_pdf_text(uploaded_file)
        return jsonify({"resume_text": resume_text})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/generate-questions", methods=["POST"])
def generate_questions():
    # Generate role-aware interview questions from extracted resume text.
    payload = request.get_json(silent=True) or {}
    role = (payload.get("role") or "Data Analyst").strip()
    resume_text = payload.get("resume_text") or ""
    count = payload.get("count", 4)

    if not resume_text.strip():
        return jsonify({"error": "resume_text is required."}), 400

    try:
        count = int(count)
    except Exception:
        count = 4

    count = min(max(count, 1), 6)

    try:
        questions = generate_interview_questions(resume_text, role, count=count)
        return jsonify({"questions": questions})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/evaluate-answer", methods=["POST"])
def evaluate_answer_route():
    # Score one interview answer and return coaching feedback payload.
    if not has_any_gemini_api_key():
        return jsonify({"error": GEMINI_KEY_MISSING_ERROR}), 500

    payload = request.get_json(silent=True) or {}
    role = (payload.get("role") or "Data Scientist").strip()
    question = payload.get("question") or ""
    answer = payload.get("answer") or ""

    if not question.strip() or not answer.strip():
        return jsonify({"error": "question and answer are required."}), 400

    try:
        result = evaluate_answer(question, answer, role)
        return jsonify(result)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/save-session", methods=["POST"])
def save_session():
    # Persist full interview session (questions/answers/scores) to Firestore.
    payload = request.get_json(silent=True) or {}

    try:
        result = save_interview_session(payload)
        return jsonify(result)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400


# Body-language frame/video analysis endpoints.
@app.route("/analyze-body", methods=["POST"])
def analyze_body():
    # Analyze either live frame uploads or full uploaded video for body-language signals.
    video_file = request.files.get("video")
    frame_file = request.files.get("frame")

    if not video_file and not frame_file:
        return jsonify({"error": "Provide either 'video' or 'frame' file."}), 400

    try:
        if frame_file:
            frame_bytes = np.frombuffer(frame_file.read(), np.uint8)
            frame = cv2.imdecode(frame_bytes, cv2.IMREAD_COLOR)
            if frame is None:
                return jsonify({"error": "Invalid frame image."}), 400

            session_id = (request.form.get("sessionId") or "").strip()
            if session_id:
                # Reuse detector across frame stream for better temporal stability.
                _cleanup_idle_live_detectors()
                detector = LIVE_FRAME_DETECTORS.get(session_id)
                if detector is None:
                    detector = PostureDetector(inference_scale=0.75, face_interval=3)
                    LIVE_FRAME_DETECTORS[session_id] = detector

                LIVE_DETECTOR_LAST_SEEN[session_id] = time.time()
                annotated, metrics = detector.process_frame(frame)
                if metrics is None:
                    frame_metrics = {
                        "status": "No posture detected",
                        "issues": ["Warning: Person Out of Frame"],
                    }
                else:
                    frame_metrics = _frame_metrics_dict(metrics)
                annotated_frame_jpeg = _encode_frame_jpeg(annotated)
            else:
                # Stateless one-off frame analysis when no live session id is provided.
                frame_metrics = _analyze_single_frame_metrics(frame)
                annotated_frame_jpeg = ""

            result = {
                "source": "frame",
                "frame_metrics": frame_metrics,
                "annotated_frame_jpeg": annotated_frame_jpeg,
                "sessionId": session_id or None,
            }
            return jsonify(result)

        file_suffix = Path(video_file.filename or "upload.mp4").suffix or ".mp4"
        temp_path = ""
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=file_suffix) as temp_file:
                video_file.save(temp_file)
                temp_path = temp_file.name

            result = _analyze_video_file(temp_path)
            result["source"] = "video"
            return jsonify(result)
        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/end-body-session", methods=["POST"])
def end_body_session():
    # Explicitly release resources tied to a live frame-analysis session.
    payload = request.get_json(silent=True) or {}
    session_id = (payload.get("sessionId") or "").strip()

    if not session_id:
        return jsonify({"error": "sessionId is required."}), 400

    detector = LIVE_FRAME_DETECTORS.pop(session_id, None)
    LIVE_DETECTOR_LAST_SEEN.pop(session_id, None)
    if detector:
        detector.release()

    return jsonify({"ok": True, "sessionId": session_id})


@app.route("/summarize-body-session", methods=["OPTIONS"])
def summarize_body_session_options():
    return ("", 204)


@app.route("/summarize-body-session", methods=["POST"])
def summarize_body_session():
    # Aggregate client-collected frame metrics into final score/tips summary.
    payload = request.get_json(silent=True) or {}
    metrics_input = payload.get("metrics", [])

    if not isinstance(metrics_input, list) or len(metrics_input) == 0:
        return jsonify({"error": "Provide non-empty metrics list."}), 400

    try:
        metrics_objects = []
        for metric in metrics_input:
            metrics_objects.append(
                PostureMetrics(
                    shoulder_angle=float(metric.get("shoulder_angle", 0.0)),
                    head_tilt=float(metric.get("head_tilt", 0.0)),
                    head_motion_score=float(metric.get("head_motion_score", 0.0)),
                    eye_contact_maintained=bool(metric.get("eye_contact_maintained", False)),
                    eye_contact_score=float(metric.get("eye_contact_score", 0.0)),
                    excessive_looking_away=bool(metric.get("excessive_looking_away", False)),
                    eye_contact_duration=float(metric.get("eye_contact_duration", 0.0)),
                    is_slouching=bool(metric.get("is_slouching", False)),
                    is_tilted=bool(metric.get("is_tilted", False)),
                    is_head_moving=bool(metric.get("is_head_moving", False)),
                    left_iris_relative=metric.get("left_iris_relative"),
                    right_iris_relative=metric.get("right_iris_relative"),
                    issues=metric.get("issues", []) or [],
                    timestamp=float(metric.get("timestamp", 0.0)),
                )
            )

        result = summarize_metrics(metrics_objects)
        result["source"] = "live-session"
        return jsonify(result)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)



   