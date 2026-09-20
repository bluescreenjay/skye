import { useEffect, useRef, useState } from "react";
import { transcribe } from "./api";

export function VoiceInput({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelled = useRef(false);
  const monitorFrame = useRef<number | null>(null); const audioContext = useRef<AudioContext | null>(null); const heardSpeech = useRef(false); const silenceSince = useRef<number | null>(null);
  const cleanup = () => { if (timer.current) clearTimeout(timer.current); if (monitorFrame.current !== null) cancelAnimationFrame(monitorFrame.current); void audioContext.current?.close().catch(() => undefined); stream.current?.getTracks().forEach((track) => track.stop()); timer.current = null; monitorFrame.current = null; stream.current = null; recorder.current = null; };
  useEffect(() => () => { cancelled.current = true; recorder.current?.stop(); cleanup(); }, []);
  const stop = () => { recorder.current?.stop(); setState("transcribing"); };
  const start = async () => {
    setError(""); cancelled.current = false;
    if (!window.isSecureContext) { setError("Microphone access requires HTTPS on your phone. A LAN address opened with http:// cannot record audio."); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("This browser does not support microphone recording."); return; }
    try {
      const captured = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelled.current) { captured.getTracks().forEach((track) => track.stop()); return; }
      stream.current = captured;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const active = new MediaRecorder(captured, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      active.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      active.onstop = async () => {
        cleanup();
        if (cancelled.current) { setState("idle"); return; }
        try { const text = await transcribe(new Blob(chunks, { type: active.mimeType || "audio/mp4" })); if (!cancelled.current) onText(text); }
        catch (caught) { if (!cancelled.current) setError(caught instanceof Error ? caught.message : "Voice input failed"); }
        finally { if (!cancelled.current) setState("idle"); }
      };
      recorder.current = active; active.start(); setState("recording");
      const context = new AudioContext(); audioContext.current = context; const analyser = context.createAnalyser(); analyser.fftSize = 512; const source = context.createMediaStreamSource(captured); source.connect(analyser); const samples = new Uint8Array(analyser.fftSize); heardSpeech.current = false; silenceSince.current = null;
      const monitor = () => { analyser.getByteTimeDomainData(samples); const volume = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length); if (volume > 0.025) { heardSpeech.current = true; silenceSince.current = null; } else if (heardSpeech.current) { silenceSince.current ??= Date.now(); if (Date.now() - silenceSince.current > 1_200 && recorder.current === active) { stop(); return; } } monitorFrame.current = requestAnimationFrame(monitor); };
      monitorFrame.current = requestAnimationFrame(monitor);
      timer.current = setTimeout(stop, 20_000);
    } catch { setError("Microphone access was denied."); cleanup(); setState("idle"); }
  };
  const cancel = () => { cancelled.current = true; recorder.current?.stop(); cleanup(); setState("idle"); };
  return <div className="voice-control"><button type="button" className="quiet" disabled={disabled || state === "transcribing"} onClick={state === "recording" ? stop : () => void start()}>{state === "recording" ? "stop recording" : state === "transcribing" ? "transcribing…" : "🎙 speak"}</button>{state === "recording" && <button type="button" className="quiet" onClick={cancel}>cancel</button>}{error && <small className="error" role="alert">{error}</small>}</div>;
}
