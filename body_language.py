# Body language detection using MediaPipe pose + face landmarks.
# Quick install: pip install opencv-python mediapipe==0.10.31 numpy argparse json

import argparse
import json
import os
import tempfile
import time
import urllib.request
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Generator, List, Optional, Tuple

import cv2
import numpy as np
import mediapipe as mp
from flask import Flask, jsonify, request
from mediapipe.tasks.python import BaseOptions, vision


@dataclass
class PostureMetrics:
    # Data class to store posture analysis metrics.

    shoulder_angle: float
    head_tilt: float
    head_motion_score: float
    eye_contact_maintained: bool
    eye_contact_score: float
    excessive_looking_away: bool
    eye_contact_duration: float
    is_slouching: bool
    is_tilted: bool
    is_head_moving: bool
    left_iris_relative: Optional[float]
    right_iris_relative: Optional[float]
    issues: List[str]
    timestamp: float

    def to_json(self) -> str:
        # Convert metrics to JSON string.
        return json.dumps(asdict(self))

    def to_dict(self) -> Dict:
        # Convert metrics to dictionary.
        return asdict(self)


class PostureDetector:
    # Detects and analyzes posture from camera frames.

    def __init__(self, inference_scale: float = 0.75, face_interval: int = 3) -> None:
        # Initialize models, thresholds, and short-term state buffers.
        # Local cache for downloaded MediaPipe task models.
        self.MODEL_DIR = Path(__file__).resolve().parent / ".models"
        self.MODEL_URLS = {
            "pose": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
            "face": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        }
        # Landmark indices used for posture geometry.
        self.POSE_NOSE_IDX = 0
        self.POSE_LEFT_EAR_IDX = 7
        self.POSE_RIGHT_EAR_IDX = 8
        self.POSE_LEFT_SHOULDER_IDX = 11
        self.POSE_RIGHT_SHOULDER_IDX = 12
        self.inference_scale = min(max(float(inference_scale), 0.35), 1.0)
        self.face_interval = max(1, int(face_interval))

        model_paths = self._ensure_models()

        # Pose model runs in VIDEO mode to leverage temporal tracking.
        self.pose = vision.PoseLandmarker.create_from_options(
            vision.PoseLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_paths["pose"])),
                running_mode=vision.RunningMode.VIDEO,
                num_poses=3,
                min_pose_detection_confidence=0.5,
                min_pose_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
        )

        # Face model used only for eye-contact estimation.
        self.face_mesh = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=str(model_paths["face"])),
                running_mode=vision.RunningMode.VIDEO,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
        )

        # Decision thresholds.
        self.HEAD_TILT_MAX = 8.0
        self.SHOULDER_ANGLE_MAX = 7.0
        self.HEAD_MOTION_THRESHOLD = 9.0
        self.EYE_CONTACT_DURATION_THRESHOLD = 2.0
        self.LEFT_EYE_MIN = 2.52
        self.LEFT_EYE_MAX = 2.96
        self.RIGHT_EYE_MIN = -2.96
        self.RIGHT_EYE_MAX = -2.52
        self.OUT_OF_FRAME_MARGIN = 0.04

        # Short moving-average buffers to reduce jitter.
        self.metric_history = {
            "shoulder_angle": [],
            "head_tilt": [],
        }
        self.history_size = 5

        self.head_position_history = deque(maxlen=10)
        self.head_motion_buffer = deque(maxlen=30)

        self.looking_away_start_time: Optional[float] = None
        self.eye_contact_total_samples = 0
        self.eye_contact_positive_samples = 0
        self.last_left_iris: Optional[float] = None
        self.last_right_iris: Optional[float] = None
        self.frame_index = 0
        self.start_perf_time = time.perf_counter()
        self.last_face_landmarks = None
        self.frames_without_pose = 0

    def _download_file(self, url: str, output_path: Path) -> None:
        # Download a model file to disk.
        output_path.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, output_path)

    def _ensure_models(self) -> Dict[str, Path]:
        # Ensure required model assets exist locally and return their paths.
        # Keep model files on disk so startup remains fast after first run.
        model_paths = {
            "pose": self.MODEL_DIR / "pose_landmarker_lite.task",
            "face": self.MODEL_DIR / "face_landmarker.task",
        }

        for key, path in model_paths.items():
            if not path.exists():
                self._download_file(self.MODEL_URLS[key], path)

        return model_paths

    def smooth_metric(self, metric_name: str, value: float) -> float:
        # Apply a small moving average to reduce noisy frame-by-frame jitter.
        self.metric_history[metric_name].append(value)
        if len(self.metric_history[metric_name]) > self.history_size:
            self.metric_history[metric_name].pop(0)
        return float(np.mean(self.metric_history[metric_name]))

    @staticmethod
    def calculate_slope_angle(point1: Tuple[float, float], point2: Tuple[float, float]) -> float:
        # Return line angle (degrees) formed by two 2D points.
        x1, y1 = point1
        x2, y2 = point2
        return float(np.degrees(np.arctan2(y2 - y1, x2 - x1)))

    @staticmethod
    def horizontal_deviation(angle_degrees: float) -> float:
        # Convert any angle to deviation-from-horizontal in range [0, 90].
        normalized = ((angle_degrees + 180.0) % 360.0) - 180.0
        return float(min(abs(normalized), abs(180.0 - abs(normalized))))

    def calculate_head_motion(self, nose_coords: Tuple[float, float]) -> float:
        # Estimate head motion using average inter-frame nose displacement.
        self.head_position_history.append(nose_coords)

        if len(self.head_position_history) < 2:
            return 0.0

        prev_pos = self.head_position_history[-2]
        curr_pos = self.head_position_history[-1]

        displacement = np.sqrt((curr_pos[0] - prev_pos[0]) ** 2 + (curr_pos[1] - prev_pos[1]) ** 2)
        self.head_motion_buffer.append(displacement)

        return float(np.mean(list(self.head_motion_buffer)))

    def check_eye_contact(self, face_landmarks) -> Tuple[bool, float, Optional[float], Optional[float]]:
        # Compute eye-contact state and away duration from iris positions.
        if not face_landmarks:
            # Current behavior: if face is not available, treat as neutral/no penalty.
            return True, 0.0, None, None

        left_iris_indices = [474, 475, 476, 477]
        right_iris_indices = [469, 470, 471, 472]

        left_iris_x = float(np.mean([face_landmarks[i].x for i in left_iris_indices]))
        right_iris_x = float(np.mean([face_landmarks[i].x for i in right_iris_indices]))

        left_eye_left = face_landmarks[33].x
        left_eye_right = face_landmarks[133].x
        right_eye_left = face_landmarks[263].x
        right_eye_right = face_landmarks[362].x

        left_eye_width = abs(left_eye_right - left_eye_left)
        right_eye_width = abs(right_eye_right - right_eye_left)

        # Normalize iris position within each eye width.
        left_iris_relative = (left_iris_x - left_eye_left) / left_eye_width if left_eye_width > 0 else 0.5
        right_iris_relative = (right_iris_x - right_eye_left) / right_eye_width if right_eye_width > 0 else 0.5

        left_centered = self.LEFT_EYE_MIN <= left_iris_relative <= self.LEFT_EYE_MAX
        right_centered = self.RIGHT_EYE_MIN <= right_iris_relative <= self.RIGHT_EYE_MAX
        is_looking = left_centered and right_centered

        self.eye_contact_total_samples += 1
        if is_looking:
            self.eye_contact_positive_samples += 1

        current_time = time.time()
        if not is_looking:
            # Start (or continue) away timer while eyes are not centered.
            if self.looking_away_start_time is None:
                self.looking_away_start_time = current_time
            duration_away = current_time - self.looking_away_start_time
        else:
            # Reset away timer immediately when eye contact is regained.
            self.looking_away_start_time = None
            duration_away = 0.0

        return is_looking, duration_away, left_iris_relative, right_iris_relative

    def analyze_posture(self, pose_landmarks, face_landmarks, image_shape, people_count: int) -> Optional[PostureMetrics]:
        # Convert landmarks into posture metrics and issue flags for one frame.
        if not pose_landmarks:
            return None

        h, w = image_shape[:2]

        nose = pose_landmarks[self.POSE_NOSE_IDX]
        left_shoulder = pose_landmarks[self.POSE_LEFT_SHOULDER_IDX]
        right_shoulder = pose_landmarks[self.POSE_RIGHT_SHOULDER_IDX]
        left_ear = pose_landmarks[self.POSE_LEFT_EAR_IDX]
        right_ear = pose_landmarks[self.POSE_RIGHT_EAR_IDX]

        nose_coords = (nose.x * w, nose.y * h)
        left_shoulder_coords = (left_shoulder.x * w, left_shoulder.y * h)
        right_shoulder_coords = (right_shoulder.x * w, right_shoulder.y * h)
        left_ear_coords = (left_ear.x * w, left_ear.y * h)
        right_ear_coords = (right_ear.x * w, right_ear.y * h)

        shoulder_slope = self.calculate_slope_angle(left_shoulder_coords, right_shoulder_coords)
        # Convert raw line angle into deviation from horizontal (0..90).
        shoulder_angle_raw = self.horizontal_deviation(shoulder_slope)
        shoulder_angle = self.smooth_metric("shoulder_angle", shoulder_angle_raw)

        head_slope = self.calculate_slope_angle(left_ear_coords, right_ear_coords)
        head_tilt_raw = self.horizontal_deviation(head_slope)
        head_tilt = self.smooth_metric("head_tilt", head_tilt_raw)

        keypoints = [nose, left_shoulder, right_shoulder, left_ear, right_ear]
        # Flag when key landmarks approach frame borders.
        is_out_of_frame = any(
            kp.x < self.OUT_OF_FRAME_MARGIN
            or kp.x > (1.0 - self.OUT_OF_FRAME_MARGIN)
            or kp.y < self.OUT_OF_FRAME_MARGIN
            or kp.y > (1.0 - self.OUT_OF_FRAME_MARGIN)
            for kp in keypoints
        )

        head_motion = self.calculate_head_motion(nose_coords)
        is_looking, time_looking_away, left_iris_rel, right_iris_rel = self.check_eye_contact(face_landmarks)

        self.last_left_iris = left_iris_rel
        self.last_right_iris = right_iris_rel

        issues: List[str] = []
        # Threshold-based decisions.
        is_slouching = shoulder_angle > self.SHOULDER_ANGLE_MAX
        is_tilted = head_tilt > self.HEAD_TILT_MAX
        is_head_moving = head_motion > self.HEAD_MOTION_THRESHOLD
        eye_contact_maintained = time_looking_away <= self.EYE_CONTACT_DURATION_THRESHOLD and is_looking
        eye_contact_score = (
            (self.eye_contact_positive_samples / self.eye_contact_total_samples) * 100.0
            if self.eye_contact_total_samples > 0
            else 0.0
        )
        excessive_looking_away = not eye_contact_maintained

        if is_slouching:
            issues.append("Shoulders Not Level")
        if is_tilted:
            issues.append("Head Tilted")
        if is_head_moving:
            issues.append("Excessive Head Movement")
        if not eye_contact_maintained:
            issues.append("Missing Eye Contact")
        if is_out_of_frame:
            issues.append("Warning: Person Out of Frame")
        if people_count > 1:
            issues.append("Warning: Multiple People Detected")

        return PostureMetrics(
            shoulder_angle=shoulder_angle,
            head_tilt=head_tilt,
            head_motion_score=head_motion,
            eye_contact_maintained=eye_contact_maintained,
            eye_contact_score=eye_contact_score,
            excessive_looking_away=excessive_looking_away,
            eye_contact_duration=time_looking_away,
            is_slouching=is_slouching,
            is_tilted=is_tilted,
            is_head_moving=is_head_moving,
            left_iris_relative=left_iris_rel,
            right_iris_relative=right_iris_rel,
            issues=issues,
            timestamp=time.time(),
        )

    def draw_shoulder_line(self, image, pose_landmarks) -> None:
        # Draw a line between shoulder landmarks as a quick visual aid.
        if not pose_landmarks:
            return

        h, w = image.shape[:2]
        left_shoulder = pose_landmarks[self.POSE_LEFT_SHOULDER_IDX]
        right_shoulder = pose_landmarks[self.POSE_RIGHT_SHOULDER_IDX]

        left_point = (int(left_shoulder.x * w), int(left_shoulder.y * h))
        right_point = (int(right_shoulder.x * w), int(right_shoulder.y * h))
        cv2.line(image, left_point, right_point, (0, 255, 255), 3)

    def process_frame(self, frame):
        # Run detection pipeline for one frame and return annotated result + metrics.
        self.frame_index += 1
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        inference_rgb = rgb_frame
        # Optional downscale for faster inference while rendering full-size output.
        if self.inference_scale < 1.0:
            inference_rgb = cv2.resize(
                rgb_frame,
                None,
                fx=self.inference_scale,
                fy=self.inference_scale,
                interpolation=cv2.INTER_LINEAR,
            )

        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=inference_rgb)
        timestamp_ms = int((time.perf_counter() - self.start_perf_time) * 1000)

        # Pose is evaluated every frame for stable posture metrics.
        pose_results = self.pose.detect_for_video(mp_image, timestamp_ms)

        # Face model can be sampled less often to reduce compute.
        if self.frame_index % self.face_interval == 0:
            face_results = self.face_mesh.detect_for_video(mp_image, timestamp_ms)
            self.last_face_landmarks = face_results.face_landmarks[0] if face_results.face_landmarks else None

        metrics = None
        if pose_results.pose_landmarks:
            self.frames_without_pose = 0
            self.draw_shoulder_line(frame, pose_results.pose_landmarks[0])
            metrics = self.analyze_posture(
                pose_results.pose_landmarks[0],
                self.last_face_landmarks,
                frame.shape,
                len(pose_results.pose_landmarks),
            )
        else:
            self.frames_without_pose += 1

        return frame, metrics

    def release(self) -> None:
        # Release MediaPipe model resources.
        self.pose.close()
        self.face_mesh.close()


def _open_capture(
    input_type: str,
    camera_index: int,
    video_path: str,
    width: int,
    height: int,
) -> Tuple[cv2.VideoCapture, bool]:
    # Open webcam or video input and indicate whether frames should be mirrored.
    normalized_type = input_type.strip().lower()
    if normalized_type not in {"webcam", "video"}:
        raise ValueError(f"Unsupported input type: {input_type}. Use 'webcam' or 'video'.")

    if normalized_type == "webcam":
        if hasattr(cv2, "CAP_DSHOW"):
            cap = cv2.VideoCapture(camera_index, cv2.CAP_DSHOW)
        else:
            cap = cv2.VideoCapture(camera_index)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        mirror_frame = True
    else:
        if not video_path:
            raise ValueError("--video-path is required when --input-type is 'video'.")
        cap = cv2.VideoCapture(video_path)
        mirror_frame = False

    if not cap.isOpened():
        source_desc = f"camera index {camera_index}" if normalized_type == "webcam" else f"video file: {video_path}"
        raise RuntimeError(f"Could not open input source ({source_desc}).")

    return cap, mirror_frame


def _format_metrics_line(metrics: PostureMetrics, frame_count: int) -> str:
    # Format one concise metrics line for console/text outputs.
    return (
        f"[{frame_count}] issues={metrics.issues or ['none']} "
        f"shoulder={metrics.shoulder_angle:.1f} head_tilt={metrics.head_tilt:.1f} "
        f"head_motion={metrics.head_motion_score:.1f} "
        f"eye_score={metrics.eye_contact_score:.0f}% "
        f"excessive_looking_away={'Yes' if metrics.excessive_looking_away else 'No'}"
    )


def _resolve_text_output_path(input_type: str, video_path: str, save_text: str) -> str:
    # Resolve text output path, auto-generating one for video when not provided.
    if save_text:
        return save_text
    if input_type == "video":
        video_file = Path(video_path)
        return str(video_file.with_name(f"{video_file.stem}_metrics.txt"))
    return ""


def _build_parser() -> argparse.ArgumentParser:
    # Create and return CLI argument parser.
    parser = argparse.ArgumentParser(description="Standalone body language detector")
    parser.add_argument(
        "--input-type",
        type=str,
        choices=["webcam", "video"],
        default="webcam",
        help="Input source type: webcam or video (default: webcam)",
    )
    parser.add_argument("--video-path", type=str, default="", help="Path to input video file (required for --input-type video)")
    parser.add_argument("--camera-index", type=int, default=0, help="Webcam index (default: 0)")
    parser.add_argument("--no-window", action="store_true", help="Run without OpenCV preview window")
    parser.add_argument("--save-json", type=str, default="", help="Optional output JSONL file for metrics")
    parser.add_argument("--save-text", type=str, default="", help="Optional output text file for metrics")
    parser.add_argument("--width", type=int, default=960, help="Capture width (default: 960)")
    parser.add_argument("--height", type=int, default=540, help="Capture height (default: 540)")
    parser.add_argument(
        "--inference-scale",
        type=float,
        default=0.75,
        help="Scale factor for model inference (0.35-1.0, lower is faster; default: 0.75)",
    )
    parser.add_argument(
        "--face-interval",
        type=int,
        default=3,
        help="Run face model every N frames (default: 3)",
    )
    return parser


def stream_camera_metrics(
    input_type: str = "webcam",
    video_path: str = "",
    camera_index: int = 0,
    show_video: bool = True,
    width: int = 960,
    height: int = 540,
    inference_scale: float = 0.75,
    face_interval: int = 3,
) -> Generator[Dict, None, None]:
    # Yield posture metrics as dictionaries for each processed frame.
    cap, mirror_frame = _open_capture(
        input_type=input_type,
        camera_index=camera_index,
        video_path=video_path,
        width=width,
        height=height,
    )

    detector = PostureDetector(
        inference_scale=inference_scale,
        face_interval=face_interval,
    )

    try:
        while cap.isOpened():
            success, frame = cap.read()
            if not success:
                break

            if mirror_frame:
                frame = cv2.flip(frame, 1)
            annotated_frame, metrics = detector.process_frame(frame)

            if show_video:
                cv2.imshow("Body Language Detector", annotated_frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if metrics is not None:
                yield metrics.to_dict()
    finally:
        cap.release()
        if show_video:
            cv2.destroyAllWindows()
        detector.release()


def stream_body_language(
    input_type: str = "webcam",
    video_path: str = "",
    camera_index: int = 0,
    show_video: bool = True,
    width: int = 960,
    height: int = 540,
    inference_scale: float = 0.75,
    face_interval: int = 3,
) -> Generator[PostureMetrics, None, None]:
    # Yield typed posture metrics for each processed frame.
    cap, mirror_frame = _open_capture(
        input_type=input_type,
        camera_index=camera_index,
        video_path=video_path,
        width=width,
        height=height,
    )

    detector = PostureDetector(
        inference_scale=inference_scale,
        face_interval=face_interval,
    )

    try:
        while cap.isOpened():
            success, frame = cap.read()
            if not success:
                break

            if mirror_frame:
                frame = cv2.flip(frame, 1)
            annotated_frame, metrics = detector.process_frame(frame)

            if show_video:
                cv2.imshow("Body Language Detector", annotated_frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            if metrics is not None:
                yield metrics
    finally:
        cap.release()
        if show_video:
            cv2.destroyAllWindows()
        detector.release()


def _label_from_score(score: float) -> str:
    if score >= 8:
        return "Excellent ✅"
    if score >= 6:
        return "Good ✅"
    if score >= 4:
        return "Needs Improvement ⚠️"
    return "Poor ⚠️"


def summarize_metrics(metrics_list: List[PostureMetrics]) -> Dict:
    if not metrics_list:
        return {
            "score": 0,
            "feedback": "No posture data detected. Please keep your upper body visible and try again.",
            "tips": ["Make sure your face and shoulders are clearly visible in the frame."],
            "live_metrics": {
                "posture": "No Data",
                "eye_contact": "No Data",
                "confidence": "No Data",
                "expression": "No Data",
            },
            "frames_analyzed": 0,
        }

    total_frames = len(metrics_list)
    avg_shoulder_angle = float(np.mean([metric.shoulder_angle for metric in metrics_list]))
    avg_head_tilt = float(np.mean([metric.head_tilt for metric in metrics_list]))
    avg_head_motion = float(np.mean([metric.head_motion_score for metric in metrics_list]))
    avg_eye_contact = float(np.mean([metric.eye_contact_score for metric in metrics_list]))

    issue_counter: Dict[str, int] = {}
    for metric in metrics_list:
        for issue in metric.issues:
            issue_counter[issue] = issue_counter.get(issue, 0) + 1

    slouch_ratio = issue_counter.get("Shoulders Not Level", 0) / total_frames
    tilt_ratio = issue_counter.get("Head Tilted", 0) / total_frames
    motion_ratio = issue_counter.get("Excessive Head Movement", 0) / total_frames
    eye_issue_ratio = issue_counter.get("Missing Eye Contact", 0) / total_frames

    posture_score = max(0.0, 10.0 - ((slouch_ratio + tilt_ratio + motion_ratio) * 10.0))
    eye_score_10 = max(0.0, min(10.0, avg_eye_contact / 10.0))
    confidence_score = max(0.0, min(10.0, (posture_score * 0.6) + (eye_score_10 * 0.4)))
    overall_score = round(confidence_score, 1)

    major_issues = sorted(issue_counter.items(), key=lambda item: item[1], reverse=True)[:3]

    tips: List[str] = []
    for issue_name, _count in major_issues:
        if issue_name == "Shoulders Not Level":
            tips.append("Keep your shoulders level and avoid leaning to one side.")
        elif issue_name == "Head Tilted":
            tips.append("Keep your head centered and aligned with the camera.")
        elif issue_name == "Excessive Head Movement":
            tips.append("Reduce unnecessary head movement; keep your posture steady while speaking.")
        elif issue_name == "Missing Eye Contact":
            tips.append("Look at the camera more often to maintain strong eye contact.")
        elif issue_name == "Warning: Person Out of Frame":
            tips.append("Position yourself fully in frame with both face and shoulders visible.")
        elif issue_name == "Warning: Multiple People Detected":
            tips.append("Ensure only one person is visible during analysis.")

    if not tips:
        tips.append("Great job! Keep your posture and eye contact consistent.")

    if overall_score >= 8:
        feedback = "Strong body language overall. Your posture and eye contact look interview-ready."
    elif overall_score >= 6:
        feedback = "Good performance with room to improve. Focus on steadier posture and more consistent eye contact."
    else:
        feedback = "Your body language needs improvement. Practice maintaining posture, reducing movement, and looking at the camera."

    return {
        "score": overall_score,
        "feedback": feedback,
        "tips": tips,
        "live_metrics": {
            "posture": _label_from_score(posture_score),
            "eye_contact": _label_from_score(eye_score_10),
            "confidence": _label_from_score(confidence_score),
            "expression": "Confident 😊" if overall_score >= 7 else "Neutral 😐" if overall_score >= 5 else "Tense ⚠️",
        },
        "frames_analyzed": total_frames,
        "averages": {
            "shoulder_angle": round(avg_shoulder_angle, 2),
            "head_tilt": round(avg_head_tilt, 2),
            "head_motion": round(avg_head_motion, 2),
            "eye_contact_score": round(avg_eye_contact, 2),
        },
        "top_issues": [issue_name for issue_name, _count in major_issues],
    }


def _analyze_single_frame(frame: np.ndarray) -> Dict:
    detector = PostureDetector()
    try:
        _annotated, metrics = detector.process_frame(frame)
        if metrics is None:
            return summarize_metrics([])
        return summarize_metrics([metrics])
    finally:
        detector.release()


def _analyze_single_frame_metrics(frame: np.ndarray) -> Dict:
    detector = PostureDetector()
    try:
        _annotated, metrics = detector.process_frame(frame)
        if metrics is None:
            return {
                "status": "No posture detected",
                "issues": ["Warning: Person Out of Frame"],
            }

        data = metrics.to_dict()
        data["status"] = "Good Body Language" if not metrics.issues else metrics.issues[0]
        data["excessive_looking_away_label"] = "Yes" if metrics.excessive_looking_away else "No"
        return data
    finally:
        detector.release()


def _analyze_video_file(video_path: str, max_frames: int = 450) -> Dict:
    metrics_list: List[PostureMetrics] = []

    for index, metrics in enumerate(
        stream_body_language(
            input_type="video",
            video_path=video_path,
            show_video=False,
            inference_scale=0.75,
            face_interval=3,
        )
    ):
        metrics_list.append(metrics)
        if index + 1 >= max_frames:
            break

    return summarize_metrics(metrics_list)


def create_app() -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024

    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        return response

    @app.route("/health", methods=["GET"])
    def health():
        return jsonify({"status": "ok", "service": "body-language"})

    @app.route("/analyze-body", methods=["OPTIONS"])
    def analyze_body_options():
        return ("", 204)

    @app.route("/analyze-body", methods=["POST"])
    def analyze_body():
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
                result = _analyze_single_frame(frame)
                result["source"] = "frame"
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

    return app


flask_app = create_app()


def main() -> None:
    # CLI entry point for webcam/video posture analysis.
    parser = _build_parser()
    args = parser.parse_args()

    if args.input_type == "video" and not args.video_path:
        parser.error("--video-path is required when --input-type video")

    print(f"Starting body language detection using {args.input_type} input. Press 'q' in the video window to stop.")

    # Optional output sinks.
    output_file = open(args.save_json, "a", encoding="utf-8") if args.save_json else None
    output_text_path = _resolve_text_output_path(args.input_type, args.video_path, args.save_text)
    output_text_file = open(output_text_path, "a", encoding="utf-8") if output_text_path else None

    try:
        frame_count = 0
        for metrics in stream_body_language(
            input_type=args.input_type,
            video_path=args.video_path,
            camera_index=args.camera_index,
            show_video=not args.no_window,
            width=args.width,
            height=args.height,
            inference_scale=args.inference_scale,
            face_interval=args.face_interval,
        ):
            frame_count += 1

            if output_file:
                output_file.write(json.dumps(metrics.to_dict()) + "\n")

            if output_text_file:
                output_text_file.write(_format_metrics_line(metrics, frame_count) + "\n")

            if frame_count % 30 == 0:
                print(_format_metrics_line(metrics, frame_count))
    except KeyboardInterrupt:
        pass
    finally:
        if output_file:
            output_file.close()
        if output_text_file:
            output_text_file.close()


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        flask_app.run(host="0.0.0.0", port=5001, debug=True)
    else:
        main()


BodyLanguageMetrics = PostureMetrics
BodyLanguageDetector = PostureDetector
