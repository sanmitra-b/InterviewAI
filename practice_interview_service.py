import importlib
import json
import os
import re
from datetime import datetime, timezone
from typing import Any

import google.generativeai as genai
from google.protobuf.json_format import MessageToDict


# Role-specific guidance injected into the interview-question prompt.
ROLE_GUIDANCE = {
    "Data Analyst": "Focus on SQL, data validation, dashboarding, KPI design, and stakeholder communication.",
    "ML Engineer": "Focus on model deployment, MLOps, monitoring, and scaling ML systems.",
    "Accountant": "Focus on financial reporting, reconciliation, controls, taxation basics, and compliance.",
}


# Deterministic local fallback content used when model/tool calling fails.
FALLBACK_QUESTIONS = {
    "Data Analyst": [
        "(Easy) What is the difference between a row and a column in a dataset?",
        "(Easy) Which SQL clause would you use to filter records and why?",
        "(Moderate) How do you validate data quality before building a dashboard?",
        "(Moderate) Describe a case where your analysis changed a stakeholder decision.",
    ],
    "ML Engineer": [
        "(Easy) What is overfitting, and how do you usually reduce it?",
        "(Easy) Why is train/validation/test splitting important?",
        "(Moderate) Describe your end-to-end workflow from training to production release.",
        "(Moderate) What trade-offs do you consider between latency and model accuracy in production?",
    ],
    "Accountant": [
        "(Easy) What is the purpose of a balance sheet?",
        "(Easy) What is the difference between accounts payable and accounts receivable?",
        "(Moderate) How do you investigate and resolve account reconciliation mismatches?",
        "(Moderate) What controls do you use to prevent reporting errors during month-end close?",
    ],
}

MODEL_NAME = "gemini-2.5-flash-lite"
_FIREBASE_APP_INITIALIZED = False
GEMINI_REQUEST_TIMEOUT_SEC = 25


# Structured function-calling names used with Gemini tools.
QUESTIONS_FUNCTION_NAME = "return_interview_questions"
EVALUATION_FUNCTION_NAME = "return_answer_evaluation"

QUESTIONS_FUNCTION_DECLARATION = genai.protos.FunctionDeclaration(
    name=QUESTIONS_FUNCTION_NAME,
    description="Return interview questions as structured arguments.",
    parameters=genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            "questions": genai.protos.Schema(
                type=genai.protos.Type.ARRAY,
                description="Ordered list of interview questions.",
                items=genai.protos.Schema(type=genai.protos.Type.STRING),
            )
        },
        required=["questions"],
    ),
)

EVALUATION_FUNCTION_DECLARATION = genai.protos.FunctionDeclaration(
    name=EVALUATION_FUNCTION_NAME,
    description="Return interview answer evaluation as structured arguments.",
    parameters=genai.protos.Schema(
        type=genai.protos.Type.OBJECT,
        properties={
            "score": genai.protos.Schema(type=genai.protos.Type.NUMBER, description="Score from 0 to 10."),
            "strengths": genai.protos.Schema(
                type=genai.protos.Type.ARRAY,
                items=genai.protos.Schema(type=genai.protos.Type.STRING),
                description="Key strengths in the answer.",
            ),
            "improvements": genai.protos.Schema(
                type=genai.protos.Type.ARRAY,
                items=genai.protos.Schema(type=genai.protos.Type.STRING),
                description="Actionable improvements for the answer.",
            ),
            "feedback": genai.protos.Schema(type=genai.protos.Type.STRING, description="Overall concise feedback."),
            "sample_answer": genai.protos.Schema(
                type=genai.protos.Type.STRING,
                description="A concise improved example answer.",
            ),
        },
        required=["score", "strengths", "improvements", "feedback", "sample_answer"],
    ),
)


def get_gemini_api_keys() -> list[str]:
    # Read primary/fallback/legacy Gemini keys and de-duplicate while preserving order.
    primary = (os.getenv("GOOGLE_API_KEY_MAIN") or "").strip()
    fallback = (os.getenv("GOOGLE_API_KEY_FALLBACK") or "").strip()
    legacy = (os.getenv("GOOGLE_API_KEY") or "").strip()

    keys = []
    for candidate in [primary, fallback, legacy]:
        if candidate and candidate not in keys:
            keys.append(candidate)

    return keys


def has_any_gemini_api_key() -> bool:
    # Lightweight health check used by request handlers before model calls.
    return len(get_gemini_api_keys()) > 0


def configure_gemini_if_available() -> bool:
    # Configure SDK with first available key for basic startup readiness.
    keys = get_gemini_api_keys()
    if not keys:
        return False

    genai.configure(api_key=keys[0])
    return True


def generate_content_with_failover(
    model_name: str,
    content,
    generation_config: dict | None = None,
    tools=None,
    tool_config=None,
    request_options: dict | None = None,
):
    # Attempt request with each configured key until one succeeds.
    keys = get_gemini_api_keys()
    if not keys:
        raise RuntimeError(
            "No Gemini API keys configured. Set GOOGLE_API_KEY_MAIN and GOOGLE_API_KEY_FALLBACK (or GOOGLE_API_KEY)."
        )

    last_error = None
    for key in keys:
        try:
            genai.configure(api_key=key)
            model = genai.GenerativeModel(model_name)
            request_kwargs = {}
            if generation_config is not None:
                request_kwargs["generation_config"] = generation_config
            if tools is not None:
                request_kwargs["tools"] = tools
            if tool_config is not None:
                request_kwargs["tool_config"] = tool_config
            if request_options is not None:
                request_kwargs["request_options"] = request_options

            # Return immediately on first successful key/model response.
            return model.generate_content(content, **request_kwargs)
        except Exception as exc:
            last_error = exc

    raise RuntimeError("Gemini request failed for both primary and fallback API keys.") from last_error


def extract_pdf_text(file_storage) -> str:
    # Extract all readable text from uploaded PDF resume.
    if file_storage is None:
        raise ValueError("Missing resume file.")

    filename = (file_storage.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise ValueError("Only PDF resumes are supported for mock interview.")

    pdf_bytes = file_storage.read()
    if not pdf_bytes:
        raise ValueError("Uploaded PDF is empty.")

    try:
        fitz = importlib.import_module("fitz")
    except Exception as exc:
        raise RuntimeError("PyMuPDF is not installed. Install package 'pymupdf'.") from exc

    text_parts = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        for page in document:
            page_text = (page.get_text() or "").strip()
            if page_text:
                text_parts.append(page_text)

    resume_text = "\n\n".join(text_parts).strip()
    if not resume_text:
        raise ValueError("Could not extract text from the PDF.")

    return resume_text


def _extract_function_args(response: Any, expected_function_name: str) -> dict:
    # Parse function-call arguments from model response candidates.
    candidates = getattr(response, "candidates", None) or []
    expected_name = (expected_function_name or "").strip().lower()
    saw_invalid_function_call = False

    for candidate in candidates:
        finish_reason = getattr(candidate, "finish_reason", None)
        if str(finish_reason) in {"10", "MALFORMED_FUNCTION_CALL"}:
            saw_invalid_function_call = True

        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []

        for part in parts:
            function_call = getattr(part, "function_call", None)
            if not function_call:
                continue

            call_name = str(getattr(function_call, "name", "") or "").strip().lower()
            if expected_name and call_name and call_name != expected_name:
                continue

            args = getattr(function_call, "args", None)
            if args is None:
                continue

            try:
                return MessageToDict(args, preserving_proto_field_name=True)
            except Exception:
                pass

            if isinstance(args, dict):
                return args

            try:
                return dict(args)
            except Exception:
                pass

            if isinstance(args, str):
                try:
                    parsed_args = json.loads(args)
                    if isinstance(parsed_args, dict):
                        return parsed_args
                except Exception:
                    pass

    fallback = _extract_json_like_object(_safe_response_text(response))
    if isinstance(fallback, dict):
        return fallback

    if saw_invalid_function_call:
        raise ValueError("Gemini produced an invalid function call payload.")

    raise ValueError(f"Gemini did not return function call args for '{expected_function_name}'.")


def _extract_json_like_object(text: str) -> dict | list | None:
    # Best-effort parser for JSON-like snippets in free-form model output.
    cleaned = (text or "").strip()
    if not cleaned:
        return None

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, (dict, list)):
            return parsed
    except Exception:
        pass

    match = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", cleaned)
    if not match:
        return None

    candidate = match.group(1)
    candidate = re.sub(r",\s*([}\]])", r"\1", candidate)
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, (dict, list)):
            return parsed
    except Exception:
        return None

    return None


def _safe_response_text(response: Any) -> str:
    # Flatten textual candidate parts for fallback extraction/parsing.
    candidates = getattr(response, "candidates", None) or []
    text_chunks = []

    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            part_text = getattr(part, "text", None)
            if part_text:
                text_chunks.append(str(part_text))

    return "\n".join(text_chunks).strip()


def _call_tool_with_failover(
    prompt: str,
    function_name: str,
    function_declaration,
    max_output_tokens: int,
    temperature: float,
) -> dict:
    # Execute tool-calling request with deterministic fallback temperature.
    tool = genai.protos.Tool(function_declarations=[function_declaration])
    tool_config = genai.protos.ToolConfig(
        function_calling_config=genai.protos.FunctionCallingConfig(
            mode=genai.protos.FunctionCallingConfig.Mode.ANY,
            allowed_function_names=[function_name],
        )
    )

    last_error = None
    # Retry once with deterministic temperature to reduce malformed tool calls.
    for attempt, temp in enumerate([temperature, 0.0], start=1):
        try:
            response = generate_content_with_failover(
                MODEL_NAME,
                prompt,
                generation_config={
                    "temperature": temp,
                    "max_output_tokens": max_output_tokens,
                },
                tools=[tool],
                tool_config=tool_config,
                request_options={"timeout": GEMINI_REQUEST_TIMEOUT_SEC},
            )
            return _extract_function_args(response, function_name)
        except Exception as exc:
            last_error = exc
            if attempt == 1:
                continue

    raise RuntimeError(f"Tool calling failed for '{function_name}'.") from last_error


def generate_interview_questions(resume_text: str, role: str, count: int = 4) -> list[str]:
    # Return role-aligned interview questions derived from resume context.
    selected_role = role if role in ROLE_GUIDANCE else "Data Analyst"
    role_text = ROLE_GUIDANCE.get(selected_role, ROLE_GUIDANCE["Data Analyst"])

    resume_excerpt = (resume_text or "").strip()[:12000]
    prompt = f"""
You are an expert technical interviewer.
Role: {selected_role}
Role guidance: {role_text}

Resume excerpt:
{resume_excerpt}

Call the provided function.
Return exactly {count} concise interview questions.
At least one question must reference the candidate's project/work experience.
If count is 4, enforce this order: first 2 easy, next 2 moderate.
"""

    try:
        parsed = _call_tool_with_failover(
            prompt=prompt,
            function_name=QUESTIONS_FUNCTION_NAME,
            function_declaration=QUESTIONS_FUNCTION_DECLARATION,
            max_output_tokens=320,
            temperature=0.2,
        )
    except Exception:
        return _fallback_questions_for_role(selected_role, count)

    parsed_questions = parsed.get("questions") if isinstance(parsed, dict) else parsed

    if isinstance(parsed_questions, str):
        parsed_questions = [line.strip(" -•\t") for line in parsed_questions.splitlines() if line.strip()]

    cleaned_questions = [str(item).strip() for item in (parsed_questions or []) if str(item).strip()]
    if not cleaned_questions:
        return _fallback_questions_for_role(selected_role, count)

    return cleaned_questions[:count]


def _fallback_questions_for_role(role: str, count: int) -> list[str]:
    # Safe local fallback when model tool-call path fails.
    selected_role = role if role in FALLBACK_QUESTIONS else "Data Analyst"
    questions = FALLBACK_QUESTIONS[selected_role]
    safe_count = min(max(int(count or 4), 1), len(questions))
    return questions[:safe_count]


def evaluate_answer(question: str, answer: str, role: str) -> dict:
    # Score a candidate answer and return concise coaching feedback.
    if not question.strip():
        raise ValueError("Question is required.")

    if not answer.strip():
        raise ValueError("Answer is required.")

    question_text = question.strip()[:600]
    answer_text = answer.strip()[:3200]
    prompt = f"""
You are an interview coach.
Role: {role or 'General AI/ML'}
Question: {question_text}
Student Answer: {answer_text}

Call the provided function.
Rules:
- score: 0 to 10
- strengths: 2 short points
- improvements: 2 short points
- feedback: max 55 words
- sample_answer: max 70 words
"""

    try:
        parsed = _call_tool_with_failover(
            prompt=prompt,
            function_name=EVALUATION_FUNCTION_NAME,
            function_declaration=EVALUATION_FUNCTION_DECLARATION,
            max_output_tokens=170,
            temperature=0.2,
        )
    except Exception:
        return _local_fallback_evaluation(answer_text)

    normalized = _normalize_evaluation_payload(parsed)

    if normalized is None:
        return _local_fallback_evaluation(answer_text)

    normalized = _ensure_feedback_lists(normalized)

    return normalized


def _ensure_feedback_lists(evaluation: dict) -> dict:
    # Guarantee minimum coaching payload quality even with sparse model output.
    strengths = evaluation.get("strengths") or []
    improvements = evaluation.get("improvements") or []

    if len(strengths) < 2:
        strengths = [
            "You addressed the question directly with relevant points.",
            "Your answer had a clear flow and understandable structure.",
        ]

    if len(improvements) < 2:
        improvements = [
            "Add one measurable outcome (number, percentage, or timeline).",
            "Use a clearer structure such as Situation, Action, and Result.",
        ]

    evaluation["strengths"] = strengths[:3]
    evaluation["improvements"] = improvements[:3]
    if not str(evaluation.get("feedback") or "").strip():
        evaluation["feedback"] = "Good start. Add concrete impact and clearer structure to improve interview performance."
    if not str(evaluation.get("sample_answer") or "").strip():
        evaluation["sample_answer"] = "I identified the problem, implemented a focused solution, and measured impact with clear metrics to show business value."

    return evaluation


def _local_fallback_evaluation(answer_text: str) -> dict:
    # Heuristic scoring fallback based on answer length only.
    word_count = len([token for token in answer_text.split() if token.strip()])
    if word_count >= 90:
        score = 8.0
    elif word_count >= 55:
        score = 7.0
    elif word_count >= 25:
        score = 6.0
    else:
        score = 5.0

    return {
        "score": score,
        "strengths": [
            "You attempted a complete response and addressed the prompt.",
            "You showed practical understanding of the topic.",
        ],
        "improvements": [
            "Add one concrete example with measurable impact.",
            "Keep the answer focused and structured in clear steps.",
        ],
        "feedback": "Solid baseline answer. Strengthen it with specifics, metrics, and a clearer structure.",
        "sample_answer": "In my previous role, I identified the issue, implemented a targeted fix, and improved the key metric by a measurable amount within a defined timeline.",
    }


def _normalize_evaluation_payload(payload: Any) -> dict | None:
    # Normalize varied model payload shapes into a single stable response schema.
    candidate = payload

    if isinstance(candidate, list) and candidate:
        dict_items = [item for item in candidate if isinstance(item, dict)]
        if dict_items:
            candidate = dict_items[0]

    if isinstance(candidate, dict):
        for key in ("result", "evaluation", "data", "output"):
            nested = candidate.get(key)
            if isinstance(nested, dict):
                candidate = nested
                break

    if not isinstance(candidate, dict):
        return None

    score = _parse_score(candidate.get("score"))
    strengths = _to_string_list(candidate.get("strengths"), fallback_key="pros", source=candidate)
    improvements = _to_string_list(candidate.get("improvements"), fallback_key="areas_of_improvement", source=candidate)
    feedback = str(candidate.get("feedback") or candidate.get("overall_feedback") or "").strip()
    sample_answer = str(candidate.get("sample_answer") or candidate.get("example_answer") or "").strip()

    return {
        "score": score,
        "strengths": strengths,
        "improvements": improvements,
        "feedback": feedback,
        "sample_answer": sample_answer,
    }


def _to_string_list(value: Any, fallback_key: str, source: dict) -> list[str]:
    # Coerce strings/lists into a clean bounded list of non-empty strings.
    raw = value
    if raw is None:
        raw = source.get(fallback_key)

    if isinstance(raw, str):
        parts = [part.strip() for part in re.split(r"\n|;|\u2022|- ", raw) if part.strip()]
        return parts[:4]

    if isinstance(raw, list):
        cleaned = [str(item).strip() for item in raw if str(item).strip()]
        return cleaned[:4]

    return []


def _parse_score(value: Any) -> float:
    # Parse numeric score and clamp to expected 0-10 range.
    if isinstance(value, (int, float)):
        return float(max(0, min(10, value)))

    if isinstance(value, str):
        match = re.search(r"\d+(?:\.\d+)?", value)
        if match:
            return float(max(0, min(10, float(match.group(0)))))

    return 0.0


def save_interview_session(payload: dict) -> dict:
    # Persist full interview session and denormalized practice score to Firestore.
    firestore_client = _get_firestore_client()

    student_id = str(payload.get("student_id") or "anonymous").strip()
    role = str(payload.get("role") or "Unknown").strip()
    questions = payload.get("questions") or []
    answers = payload.get("answers") or []
    scores = payload.get("scores") or []
    evaluations = payload.get("evaluations") or []

    if not isinstance(questions, list) or not questions:
        raise ValueError("questions must be a non-empty list.")

    if not isinstance(answers, list) or len(answers) != len(questions):
        raise ValueError("answers must be a list with the same length as questions.")

    avg_score = 0.0
    numeric_scores = []
    for value in scores:
        try:
            numeric_scores.append(float(value))
        except (TypeError, ValueError):
            continue

    if numeric_scores:
        avg_score = sum(numeric_scores) / len(numeric_scores)

    data = {
        "studentId": student_id,
        "module": "practice",
        "role": role,
        "questions": questions,
        "answers": answers,
        "scores": scores,
        "evaluations": evaluations,
        "avgScore": avg_score,
        "timestamp": datetime.now(timezone.utc),
        "startedAt": payload.get("started_at"),
        "clientTimestamp": payload.get("timestamp"),
    }

    session_doc = firestore_client.collection("students").document(student_id).collection("sessions").document()
    session_doc.set(data)

    firestore_client.collection("students").document(student_id).set(
        {
            "practiceScore": avg_score,
            "updatedAt": datetime.now(timezone.utc),
        },
        merge=True,
    )

    return {
        "ok": True,
        "session_id": session_doc.id,
        "average_score": avg_score,
    }


def _get_firestore_client():
    # Lazily initialize firebase-admin and return a Firestore client instance.
    global _FIREBASE_APP_INITIALIZED

    try:
        firebase_admin = importlib.import_module("firebase_admin")
        credentials = importlib.import_module("firebase_admin.credentials")
        firestore = importlib.import_module("firebase_admin.firestore")
    except Exception as exc:
        raise RuntimeError("firebase-admin is not installed. Install package 'firebase-admin'.") from exc

    if not _FIREBASE_APP_INITIALIZED:
        # Initialize app once per process to avoid duplicate-app errors.
        if not firebase_admin._apps:
            service_account_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH") or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            if not service_account_path:
                raise RuntimeError(
                    "Set FIREBASE_SERVICE_ACCOUNT_PATH (or GOOGLE_APPLICATION_CREDENTIALS) to your Firebase service-account JSON file."
                )

            cred = credentials.Certificate(service_account_path)
            firebase_admin.initialize_app(cred)

        _FIREBASE_APP_INITIALIZED = True

    return firestore.client()
