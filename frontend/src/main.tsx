import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Profile = { id: string; name: string; raw_text: string; bullets: { id: string; text: string; title?: string; organization?: string; location?: string; dates?: string; bullets?: string[]; category?: string }[] };
type Turn = { role: string; text: string };
type TranscriptTurn = Turn & { sessionId: string; index: number };
type Session = { id: string; bullet_id: string; status: string; current_round: number; max_rounds: number; turns: Turn[]; feedback: { strengths?: string[]; gaps?: string[]; next_step?: string } };
type VoiceRecognition = { lang: string; continuous: boolean; interimResults: boolean; onstart: (() => void) | null; onresult: ((event: { resultIndex?: number; results: { length: number; [key: number]: { isFinal: boolean; [key: number]: { transcript: string } } } }) => void) | null; onspeechstart: (() => void) | null; onspeechend: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
type VoicePhase = "idle" | "coach-speaking" | "starting-microphone" | "listening" | "silence-detected" | "submitting" | "error";

const voiceEnabled = import.meta.env.VITE_ENABLE_VOICE === "true" || new URLSearchParams(window.location.search).get("voice") === "1";
const COACH_HANDOFF_PAUSE_MS = 900;
const CANDIDATE_SILENCE_MS = 1600;

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api${path}`, { headers: { "Content-Type": "application/json" }, ...init });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};

function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("Candidate");
  const [resume, setResume] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<Session | null>(null);
  const [conversationTurns, setConversationTurns] = useState<TranscriptTurn[]>([]);
  const [answer, setAnswer] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [listening, setListening] = useState(false);
  const [waitingForSilence, setWaitingForSilence] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [coachText, setCoachText] = useState<Record<string, string>>({});
  const recognitionRef = useRef<VoiceRecognition | null>(null);
  const startingRecognitionRef = useRef(false);
  const transitionTextRef = useRef<Record<string, string>>({});
  const microphoneRef = useRef<MediaStream | null>(null);
  const finalTranscriptRef = useRef("");
  const candidateTranscriptRef = useRef("");
  const speechEndedRef = useRef(false);
  const manualStopRef = useRef(false);
  const silenceTimerRef = useRef<number | undefined>(undefined);
  const speechFallbackTimerRef = useRef<number | undefined>(undefined);
  const submissionInFlightRef = useRef(false);
  const answerRef = useRef(answer);
  const activeRef = useRef(active);
  const voicePhaseRef = useRef<VoicePhase>("idle");
  const [dashboard, setDashboard] = useState<{ bullets: { status: string; practice_count: number }[]; facts: { text: string }[] } | null>(null);
  const selectedBullet = useMemo(() => profile?.bullets.find((b) => b.id === active?.bullet_id), [profile, active]);

  useEffect(() => { answerRef.current = answer; }, [answer]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { voicePhaseRef.current = voicePhase; }, [voicePhase]);
  const logVoice = (event: string, detail = "", phase?: VoicePhase) => {
    const entry = { time: new Date().toISOString(), phase: phase || voicePhaseRef.current, event, detail };
    if (phase === "error") console.error("[Beyond the Bullet voice]", entry);
    else console.debug("[Beyond the Bullet voice]", entry);
  };
  const transitionFor = (session: Session, sourceProfile = profile) => {
    const bullet = sourceProfile?.bullets.find((item) => item.id === session.bullet_id);
    const focus = bullet?.category && bullet.category !== "experience" ? ` · ${bullet.category.toLowerCase()}` : "";
    const destination = `${bullet?.organization || bullet?.title || "the next experience"}${focus}`;
    return `Now let's move on to ${destination}.`;
  };
  const displaySession = (session: Session, withTransition = false, sourceProfile = profile) => {
    if (withTransition) transitionTextRef.current[session.id] = transitionFor(session, sourceProfile);
    const transition = transitionTextRef.current[session.id];
    if (!transition || session.turns.length === 0) return session;
    const firstAgentIndex = session.turns.findIndex((turn) => turn.role === "agent");
    if (firstAgentIndex < 0) return session;
    return { ...session, turns: session.turns.map((turn, index) => index === firstAgentIndex ? { ...turn, text: `${transition} ${turn.text}` } : turn) };
  };
  const transcriptFor = (session: Session): TranscriptTurn[] => displaySession(session).turns.map((turn, index) => ({ ...turn, sessionId: session.id, index }));
  const mergeTranscript = (session: Session) => setConversationTurns((current) => [...current.filter((turn) => turn.sessionId !== session.id), ...transcriptFor(session)]);
  const refreshProfiles = async () => setProfiles(await api<Profile[]>("/profiles"));
  useEffect(() => { refreshProfiles().catch((e) => setNotice(e.message)); }, []);

  const loadDashboard = async (id: string) => setDashboard(await api<{ bullets: { status: string; practice_count: number }[]; facts: { text: string }[] }>(`/profiles/${id}/dashboard`));
  const saveProfile = async () => {
    setBusy(true);
    try {
      const saved = await api<Profile>("/profiles", { method: "POST", body: JSON.stringify({ name, raw_text: resume }) });
      const planned = await api<Session[]>(`/profiles/${saved.id}/plan`, { method: "POST" });
      const started = await api<{ session: Session }>(`/sessions/${planned[0].id}/start`, { method: "POST" });
      const startedSession = displaySession(started.session);
      setProfile(saved); setSessions(planned.map((session) => session.id === started.session.id ? started.session : session)); setConversationTurns(transcriptFor(started.session)); setActive(startedSession); await loadDashboard(saved.id); await refreshProfiles(); setNotice("Coach started the first resume history interview.");
    } catch (e) { setNotice(String(e)); } finally { setBusy(false); }
  };
  const openProfile = async (id: string) => {
    const p = await api<Profile>(`/profiles/${id}`);
    setProfile(p); setName(p.name); setResume(p.raw_text); setActive(null); setConversationTurns([]); transitionTextRef.current = {}; setBusy(true);
    try {
      let loadedSessions = await api<Session[]>(`/profiles/${id}/sessions`);
      if (loadedSessions.length === 0) loadedSessions = await api<Session[]>(`/profiles/${id}/plan`, { method: "POST" });
      setSessions(loadedSessions);
      setConversationTurns(loadedSessions.flatMap((session) => transcriptFor(session)));
      const current = loadedSessions.find((session) => session.status === "active");
      if (current) setActive(displaySession(current));
      else {
        const next = loadedSessions.find((session) => session.status === "planned");
        if (next) await start(next, true, p);
        else {
          const latestCompleted = [...loadedSessions].reverse().find((session) => session.status === "complete");
          if (latestCompleted) setActive(displaySession(latestCompleted));
        }
      }
      await loadDashboard(id);
    } finally { setBusy(false); }
  };
  const deleteProfile = async () => { if (!profile || !window.confirm(`Delete ${profile.name} and all local practice data?`)) return; await api(`/profiles/${profile.id}`, { method: "DELETE" }); setProfile(null); setDashboard(null); setSessions([]); setResume(""); await refreshProfiles(); setNotice("Profile and related local data deleted."); };
  const start = async (session: Session, withTransition = false, sourceProfile = profile) => { const result = await api<{ session: Session }>(`/sessions/${session.id}/start`, { method: "POST" }); const visible = displaySession(result.session, withTransition, sourceProfile); setActive(visible); setSessions((current) => current.map((item) => item.id === result.session.id ? result.session : item)); mergeTranscript(result.session); };
  const startRandom = async () => { if (!profile) return; const result = await api<{ session: Session }>(`/profiles/${profile.id}/coach/start`, { method: "POST" }); setActive(result.session); setSessions((current) => [...current, result.session]); };
  const resetSession = async () => {
    if (!profile || busy) return;
    releaseMicrophone();
    setBusy(true);
    setAnswer("");
    setConversationTurns([]);
    try {
      const result = await api<{ session: Session }>(`/profiles/${profile.id}/coach/start`, { method: "POST" });
      setSessions((current) => [...current, result.session]);
      setConversationTurns(transcriptFor(result.session));
      setActive(result.session);
      setNotice("Started a new interview session from the beginning. Previous sessions were preserved.");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusy(false);
    }
  };
  const openSession = (session: Session) => { if (session.status === "complete") setActive(session); else void start(session); };

  const clearSilenceTimer = () => { if (silenceTimerRef.current !== undefined) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = undefined; logVoice("silence timer cleared"); } };
  const stopListening = () => { manualStopRef.current = true; clearSilenceTimer(); logVoice("recognition stop requested", "manual stop"); recognitionRef.current?.stop(); recognitionRef.current = null; setListening(false); setWaitingForSilence(false); setVoicePhase("idle"); };
  const releaseMicrophone = () => { stopListening(); microphoneRef.current?.getTracks().forEach((track) => track.stop()); microphoneRef.current = null; logVoice("microphone released"); };
  const sendAnswer = async (spokenAnswer?: string) => {
    const responseText = (spokenAnswer ?? answerRef.current).trim();
    if (!activeRef.current || !responseText || submissionInFlightRef.current) {
      logVoice("answer submit skipped", `active=${Boolean(activeRef.current)} text_chars=${responseText.length} in_flight=${submissionInFlightRef.current}`);
      return;
    }
    submissionInFlightRef.current = true;
    const requestStartedAt = performance.now();
    logVoice("answer submit", `${responseText.length} characters; session=${activeRef.current.id}`, "submitting");
    stopListening(); setVoicePhase("submitting"); setBusy(true);
    try {
      const result = await api<{ session: Session }>(`/sessions/${activeRef.current.id}/answer`, { method: "POST", body: JSON.stringify({ text: responseText }) });
      logVoice("answer response", `${Math.round(performance.now() - requestStartedAt)}ms; status=${result.session.status}; turns=${result.session.turns.length}`);
      const updatedSessions = sessions.map((item) => item.id === result.session.id ? result.session : item);
      const visibleSession = displaySession(result.session);
      setSessions(updatedSessions); setActive(visibleSession); mergeTranscript(result.session); setAnswer(""); finalTranscriptRef.current = ""; candidateTranscriptRef.current = "";
      if (result.session.status === "complete") {
        const next = updatedSessions.find((item) => item.status === "planned");
        if (next) await start(next, true);
      }
    } catch (e) { logVoice("answer submit failed", `${Math.round(performance.now() - requestStartedAt)}ms; ${String(e)}`, "error"); setVoicePhase("error"); setNotice(String(e)); } finally { submissionInFlightRef.current = false; setBusy(false); }
  };

  const submitAfterSilence = (delay = CANDIDATE_SILENCE_MS) => {
    clearSilenceTimer();
    if (manualStopRef.current || submissionInFlightRef.current) {
      logVoice("silence ignored", `recognition stopped=${manualStopRef.current} submission_in_flight=${submissionInFlightRef.current}`);
      return;
    }
    const transcript = (candidateTranscriptRef.current || finalTranscriptRef.current || answerRef.current).trim();
    if (!transcript) { logVoice("silence ignored", "no transcript"); setWaitingForSilence(false); return; }
    logVoice("silence detected", `${delay}ms timer for ${transcript.length} characters`, "silence-detected");
    setVoicePhase("silence-detected");
    setWaitingForSilence(true);
    silenceTimerRef.current = window.setTimeout(() => { silenceTimerRef.current = undefined; logVoice("silence timer fired", `${transcript.length} characters`); setWaitingForSilence(false); void sendAnswer(transcript); }, delay);
  };

  const startListening = async (preserveTranscript = false) => {
    const Recognition = (window as Window & { webkitSpeechRecognition?: new () => VoiceRecognition }).webkitSpeechRecognition;
    if (!voiceEnabled || !Recognition || !activeRef.current || activeRef.current.status !== "active") { if (voiceEnabled && !Recognition) setNotice("Speech recognition is not available in this browser."); return; }
    if (recognitionRef.current || startingRecognitionRef.current || submissionInFlightRef.current) { logVoice("microphone start skipped", `recognition=${Boolean(recognitionRef.current)} starting=${startingRecognitionRef.current} submitting=${submissionInFlightRef.current}`); return; }
    startingRecognitionRef.current = true;
    setVoicePhase("starting-microphone");
    logVoice("microphone start requested");
    try {
      if (!microphoneRef.current) microphoneRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      logVoice("microphone permission ready", microphoneRef.current.getTracks().map((track) => `${track.kind}:${track.readyState}`).join(","));
    } catch {
      startingRecognitionRef.current = false;
      setVoicePhase("error");
      logVoice("microphone permission failed", "getUserMedia rejected", "error");
      setNotice("Microphone access is required for voice mode. Allow microphone access and try again.");
      return;
    }
    manualStopRef.current = false; speechEndedRef.current = false;
    if (!preserveTranscript) { finalTranscriptRef.current = ""; candidateTranscriptRef.current = ""; }
    clearSilenceTimer(); setWaitingForSilence(false);
    const recognition = new Recognition(); recognition.lang = "en-US"; recognition.continuous = true; recognition.interimResults = true;
    recognition.onstart = () => { startingRecognitionRef.current = false; setListening(true); setVoicePhase("listening"); logVoice("recognition started", `mic_tracks=${microphoneRef.current?.getTracks().length || 0}`); };
    recognition.onspeechstart = () => { speechEndedRef.current = false; clearSilenceTimer(); setWaitingForSilence(false); setVoicePhase("listening"); logVoice("speech started"); };
    recognition.onresult = (event) => { let interim = ""; let finalCount = 0; const first = event.resultIndex ?? 0; for (let index = first; index < event.results.length; index += 1) { const result = event.results[index]; if (result.isFinal) { finalTranscriptRef.current += `${result[0].transcript} `; finalCount += 1; } else interim += result[0].transcript; } candidateTranscriptRef.current = `${finalTranscriptRef.current}${interim}`.trim(); setAnswer(candidateTranscriptRef.current); setVoicePhase("listening"); logVoice("recognition result", `${finalCount} final result(s), ${candidateTranscriptRef.current.length} characters`); if (finalTranscriptRef.current.trim()) submitAfterSilence(); };
    recognition.onspeechend = () => { speechEndedRef.current = true; if (manualStopRef.current || submissionInFlightRef.current) return; logVoice("speech ended", `waiting ${CANDIDATE_SILENCE_MS}ms for a real pause`); submitAfterSilence(CANDIDATE_SILENCE_MS); };
    recognition.onend = () => {
      recognitionRef.current = null; setListening(false);
      logVoice("recognition ended", manualStopRef.current ? "manual" : speechEndedRef.current ? "after speech" : "unexpected browser end");
      if (manualStopRef.current || submissionInFlightRef.current) return;
      if (speechEndedRef.current && finalTranscriptRef.current.trim() && silenceTimerRef.current === undefined) submitAfterSilence(CANDIDATE_SILENCE_MS);
      else if (activeRef.current?.status === "active") { logVoice("recognition restart scheduled", "speech did not end"); globalThis.setTimeout(() => void startListening(true), 100); }
    };
    recognitionRef.current = recognition;
    try { recognition.start(); } catch (error) { startingRecognitionRef.current = false; recognitionRef.current = null; setVoicePhase("error"); logVoice("recognition start failed", String(error), "error"); }
  };

  useEffect(() => {
    if (!voiceEnabled || !active || active.status !== "active") { releaseMicrophone(); return; }
    const latestAgentIndex = active.turns.map((turn, index) => turn.role === "agent" ? index : -1).filter((index) => index >= 0).pop();
    if (latestAgentIndex === undefined) return;
    const turn = active.turns[latestAgentIndex]; const key = `${active.id}:${latestAgentIndex}`; let cancelled = false; let interval: number | undefined;
    setVoicePhase("coach-speaking");
    logVoice("coach turn started", `${turn.text.length} characters; turn=${latestAgentIndex}`, "coach-speaking");
    setCoachText((current) => ({ ...current, [key]: "" }));
    const reveal = () => { const started = performance.now(); interval = window.setInterval(() => { const count = Math.min(turn.text.length, Math.floor((performance.now() - started) / 28)); setCoachText((current) => ({ ...current, [key]: turn.text.slice(0, count) })); if (count >= turn.text.length && interval) { window.clearInterval(interval); logVoice("coach transcript complete", `${count} characters`); } }, 20); };
    reveal();
    const startAfterCoach = (reason: string) => { if (!cancelled) { if (speechFallbackTimerRef.current !== undefined) window.clearTimeout(speechFallbackTimerRef.current); logVoice("coach handoff complete", reason); globalThis.setTimeout(() => void startListening(), COACH_HANDOFF_PAUSE_MS); } };
    const fallbackDelay = Math.max(1800, turn.text.length * 55) + COACH_HANDOFF_PAUSE_MS;
    speechFallbackTimerRef.current = window.setTimeout(() => { speechFallbackTimerRef.current = undefined; logVoice("coach speech watchdog", `${fallbackDelay}ms elapsed; speaking=${"speechSynthesis" in window ? window.speechSynthesis.speaking : false}; pending=${"speechSynthesis" in window ? window.speechSynthesis.pending : false}`); void startListening(); }, fallbackDelay);
    if ("speechSynthesis" in window) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(turn.text); utterance.onstart = () => logVoice("coach speech started", `chars=${turn.text.length}`); utterance.onend = () => startAfterCoach("speech onend"); utterance.onerror = (event) => { if (cancelled && event.error === "interrupted") { logVoice("coach speech cancellation acknowledged", "previous utterance replaced"); return; } logVoice("coach speech error", event.error || "speech synthesis error", "error"); setVoicePhase("error"); startAfterCoach(`speech onerror=${event.error || "unknown"}`); }; logVoice("coach speech queued", `speaking=${window.speechSynthesis.speaking}; pending=${window.speechSynthesis.pending}`); window.speechSynthesis.speak(utterance); } else { logVoice("speech synthesis unavailable", "using transcript timing"); startAfterCoach("no speech synthesis"); }
    return () => { cancelled = true; if (interval) window.clearInterval(interval); if (speechFallbackTimerRef.current !== undefined) window.clearTimeout(speechFallbackTimerRef.current); window.speechSynthesis?.cancel(); };
  }, [active?.id, active?.turns.length, active?.status]);

  useEffect(() => () => { releaseMicrophone(); window.speechSynthesis?.cancel(); }, []);
  const pause = async () => { if (!active) return; stopListening(); const paused = await api<Session>(`/sessions/${active.id}/pause`, { method: "POST" }); setActive(paused); setSessions(sessions.map((s) => s.id === paused.id ? paused : s)); };
  const handleFile = async (file?: File) => { if (!file) return; const form = new FormData(); form.append("file", file); const response = await fetch("/api/resume/upload", { method: "POST", body: form }); setResume((await response.json()).text); };

  return <main>
    <header><div className="brand"><span className="mark">➤</span><div><h1>Beyond the Bullet</h1><p>Be ready to defend every line.</p></div></div><div className="user-menu"><button className="ghost" onClick={() => setShowProfile(!showProfile)}>◉ {profile?.name || "Choose profile"}</button>{showProfile && <div className="popover"><strong>Local profiles</strong>{profiles.map((p) => <button key={p.id} onClick={() => { openProfile(p.id); setShowProfile(false); }}>{p.name}</button>)}{profile && dashboard && <div className="progress-card"><small>PROGRESS</small><strong>{dashboard.bullets.filter((b) => b.status === "complete").length} / {dashboard.bullets.length} bullets practiced</strong><span>{dashboard.facts.length} approved vault facts</span></div>}<button onClick={() => { setProfile(null); setDashboard(null); setResume(""); setName("Candidate"); setSessions([]); setShowProfile(false); }}>＋ New profile</button>{profile && <button className="danger" onClick={deleteProfile}>Delete profile</button>}</div>}</div></header>
    {notice && <div className="notice">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    <section className="workspace"><aside className="panel source-panel"><div className="panel-title"><span>01</span><h2>Your experience</h2></div><label className="upload">Upload resume<input type="file" accept=".txt,.pdf,.docx" onChange={(e) => handleFile(e.target.files?.[0])} /></label><label className="field">Profile name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label className="field">Paste resume or profile text<textarea value={resume} onChange={(e) => setResume(e.target.value)} placeholder="Paste a resume, project notes, or a public profile excerpt..." /></label><button className="primary" disabled={!resume.trim() || busy} onClick={saveProfile}>{busy ? "Parsing..." : "Parse & save profile"}</button>{profile && <><div className="divider"/><div className="panel-title small"><span>02</span><h2>Parsed experiences</h2></div><div className="bullets">{profile.bullets.map((bullet) => <div className="bullet experience-card" key={bullet.id}><span>✦</span><div><strong>{bullet.title || bullet.text}</strong>{bullet.organization && <small>{bullet.organization}{bullet.location ? ` · ${bullet.location}` : ""}</small>}{bullet.dates && <small>{bullet.dates}</small>}{bullet.bullets && bullet.bullets.length > 0 && <ul>{bullet.bullets.map((detail, index) => <li key={`${bullet.id}-${index}`}>{detail}</li>)}</ul>}</div></div>)}</div></>}</aside>
      <section className="panel interview-panel"><div className="panel-title"><span>03</span><h2>Interview room</h2><span className="live">{voiceEnabled ? "● VOICE MODE" : "● TEXT ONLY"}</span></div>{!active ? <div className="empty"><div className="orbit">✈</div><h3>Preparing the next conversation</h3><p>The coach will continue with the next experience automatically.</p></div> : <><div className="anchor"><small>SESSION ANCHOR</small><strong>{selectedBullet?.text}</strong><span>Round {Math.min(active.current_round, active.max_rounds)} of {active.max_rounds}</span><button className="ghost compact" onClick={() => void resetSession()} disabled={busy}>Reset / New session ↻</button></div><div className="conversation">{conversationTurns.map((turn) => { const key = `${turn.sessionId}:${turn.index}`; const latestActiveAgent = active.id === turn.sessionId && turn.role === "agent" && turn.index === active.turns.map((item, index) => item.role === "agent" ? index : -1).filter((index) => index >= 0).pop(); const text = voiceEnabled && latestActiveAgent ? (coachText[key] ?? turn.text) : turn.text; return <div className={`turn ${turn.role}`} key={`${key}-${turn.text}`}><div className="avatar">{turn.role === "agent" ? "➤" : "You"}</div><div><small>{turn.role === "agent" ? "COACH" : "YOU"}</small><p>{text}</p></div></div>; })}</div>{active.status === "active" && <div className="composer"><textarea value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAnswer(); } }} placeholder={voiceEnabled ? "Your live transcript will appear here..." : "Type your answer..."}/><div className="composer-actions"><span className="talking">● {voiceEnabled ? (waitingForSilence ? "Pause detected · sending automatically" : listening ? "Microphone listening" : voicePhase === "submitting" ? "Sending answer" : "Coach speaking") : "Text conversation is active"}</span>{voiceEnabled ? <button className="primary compact" onClick={() => sendAnswer()} disabled={busy || !answer.trim()}>Finish answer →</button> : <><button className="ghost" onClick={pause}>Pause</button><button className="primary compact" onClick={() => sendAnswer()} disabled={busy || !answer.trim()}>Send answer →</button></>}</div></div>}{active.status === "paused" && <button className="primary" onClick={() => start(active)}>Resume interview</button>}</>}
      {active?.status === "complete" && <div className="feedback session-feedback"><h3>Session reflection</h3><p>{active.feedback.next_step}</p><div className="feedback-grid"><div><small>STRENGTH</small><p>{active.feedback.strengths?.join(" ")}</p></div><div><small>KEEP EXPLORING</small><p>{active.feedback.gaps?.join(" ")}</p></div></div></div>}</section>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
