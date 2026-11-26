import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Profile = { id: string; name: string; raw_text: string; bullets: { id: string; text: string; title?: string; organization?: string; location?: string; dates?: string; bullets?: string[]; category?: string }[] };
type Turn = { role: string; text: string };
type Session = { id: string; bullet_id: string; status: string; current_round: number; max_rounds: number; turns: Turn[]; feedback: { strengths?: string[]; gaps?: string[]; next_step?: string } };
type VoiceRecognition = { lang: string; continuous: boolean; interimResults: boolean; onstart: (() => void) | null; onresult: ((event: { resultIndex?: number; results: { length: number; [key: number]: { isFinal: boolean; [key: number]: { transcript: string } } } }) => void) | null; onspeechend: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };

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
  const [answer, setAnswer] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [listening, setListening] = useState(false);
  const [waitingForSilence, setWaitingForSilence] = useState(false);
  const [coachText, setCoachText] = useState<Record<string, string>>({});
  const recognitionRef = useRef<VoiceRecognition | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const finalTranscriptRef = useRef("");
  const candidateTranscriptRef = useRef("");
  const manualStopRef = useRef(false);
  const silenceTimerRef = useRef<number | undefined>(undefined);
  const submissionInFlightRef = useRef(false);
  const answerRef = useRef(answer);
  const activeRef = useRef(active);
  const [dashboard, setDashboard] = useState<{ bullets: { status: string; practice_count: number }[]; facts: { text: string }[] } | null>(null);
  const selectedBullet = useMemo(() => profile?.bullets.find((b) => b.id === active?.bullet_id), [profile, active]);

  useEffect(() => { answerRef.current = answer; }, [answer]);
  useEffect(() => { activeRef.current = active; }, [active]);
  const refreshProfiles = async () => setProfiles(await api<Profile[]>("/profiles"));
  useEffect(() => { refreshProfiles().catch((e) => setNotice(e.message)); }, []);

  const loadDashboard = async (id: string) => setDashboard(await api<{ bullets: { status: string; practice_count: number }[]; facts: { text: string }[] }>(`/profiles/${id}/dashboard`));
  const saveProfile = async () => {
    setBusy(true);
    try {
      const saved = await api<Profile>("/profiles", { method: "POST", body: JSON.stringify({ name, raw_text: resume }) });
      const planned = await api<Session[]>(`/profiles/${saved.id}/plan`, { method: "POST" });
      const started = await api<{ session: Session }>(`/profiles/${saved.id}/coach/start`, { method: "POST" });
      setProfile(saved); setSessions([...planned, started.session]); setActive(started.session); await loadDashboard(saved.id); await refreshProfiles(); setNotice("Coach picked a resume history item and started the interview.");
    } catch (e) { setNotice(String(e)); } finally { setBusy(false); }
  };
  const openProfile = async (id: string) => { const p = await api<Profile>(`/profiles/${id}`); setProfile(p); setName(p.name); setResume(p.raw_text); setActive(null); setSessions(await api<Session[]>(`/profiles/${id}/sessions`)); await loadDashboard(id); };
  const deleteProfile = async () => { if (!profile || !window.confirm(`Delete ${profile.name} and all local practice data?`)) return; await api(`/profiles/${profile.id}`, { method: "DELETE" }); setProfile(null); setDashboard(null); setSessions([]); setResume(""); await refreshProfiles(); setNotice("Profile and related local data deleted."); };
  const start = async (session: Session) => { const result = await api<{ session: Session }>(`/sessions/${session.id}/start`, { method: "POST" }); setActive(result.session); };
  const startRandom = async () => { if (!profile) return; const result = await api<{ session: Session }>(`/profiles/${profile.id}/coach/start`, { method: "POST" }); setActive(result.session); setSessions((current) => [...current, result.session]); };
  const openSession = (session: Session) => { if (session.status === "complete") setActive(session); else void start(session); };

  const clearSilenceTimer = () => { if (silenceTimerRef.current !== undefined) { window.clearTimeout(silenceTimerRef.current); silenceTimerRef.current = undefined; } };
  const stopListening = () => { manualStopRef.current = true; clearSilenceTimer(); recognitionRef.current?.stop(); recognitionRef.current = null; setListening(false); setWaitingForSilence(false); };
  const releaseMicrophone = () => { stopListening(); microphoneRef.current?.getTracks().forEach((track) => track.stop()); microphoneRef.current = null; };
  const sendAnswer = async (spokenAnswer?: string) => {
    const responseText = (spokenAnswer ?? answerRef.current).trim();
    if (!activeRef.current || !responseText || busy || submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    stopListening(); setBusy(true);
    try {
      const result = await api<{ session: Session }>(`/sessions/${activeRef.current.id}/answer`, { method: "POST", body: JSON.stringify({ text: responseText }) });
      setActive(result.session); setSessions((current) => current.map((s) => s.id === result.session.id ? result.session : s)); setAnswer(""); finalTranscriptRef.current = ""; candidateTranscriptRef.current = "";
    } catch (e) { setNotice(String(e)); } finally { submissionInFlightRef.current = false; setBusy(false); }
  };

  const submitAfterSilence = () => {
    clearSilenceTimer();
    const transcript = (candidateTranscriptRef.current || finalTranscriptRef.current || answerRef.current).trim();
    if (!transcript) { setWaitingForSilence(false); return; }
    setWaitingForSilence(true);
    silenceTimerRef.current = window.setTimeout(() => { setWaitingForSilence(false); void sendAnswer(transcript); }, CANDIDATE_SILENCE_MS);
  };

  const startListening = async () => {
    const Recognition = (window as Window & { webkitSpeechRecognition?: new () => VoiceRecognition }).webkitSpeechRecognition;
    if (!voiceEnabled || !Recognition || !activeRef.current || activeRef.current.status !== "active") { if (voiceEnabled && !Recognition) setNotice("Speech recognition is not available in this browser."); return; }
    try {
      if (!microphoneRef.current) microphoneRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setNotice("Microphone access is required for voice mode. Allow microphone access and try again.");
      return;
    }
    manualStopRef.current = false; finalTranscriptRef.current = ""; candidateTranscriptRef.current = ""; clearSilenceTimer(); setWaitingForSilence(false);
    const recognition = new Recognition(); recognition.lang = "en-US"; recognition.continuous = true; recognition.interimResults = true;
    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => { let interim = ""; const first = event.resultIndex ?? 0; for (let index = first; index < event.results.length; index += 1) { const result = event.results[index]; if (result.isFinal) finalTranscriptRef.current += `${result[0].transcript} `; else interim += result[0].transcript; } candidateTranscriptRef.current = `${finalTranscriptRef.current}${interim}`.trim(); setAnswer(candidateTranscriptRef.current); submitAfterSilence(); };
    recognition.onspeechend = () => submitAfterSilence();
    recognition.onend = () => { recognitionRef.current = null; setListening(false); if (!manualStopRef.current && (finalTranscriptRef.current.trim() || answerRef.current.trim())) submitAfterSilence(); };
    recognitionRef.current = recognition; recognition.start();
  };

  useEffect(() => {
    if (!voiceEnabled || !active || active.status !== "active") { releaseMicrophone(); return; }
    const latestAgentIndex = active.turns.map((turn, index) => turn.role === "agent" ? index : -1).filter((index) => index >= 0).pop();
    if (latestAgentIndex === undefined) return;
    const turn = active.turns[latestAgentIndex]; const key = `${active.id}:${latestAgentIndex}`; let cancelled = false; let interval: number | undefined;
    setCoachText((current) => ({ ...current, [key]: "" }));
    const reveal = () => { const started = performance.now(); interval = window.setInterval(() => { const count = Math.min(turn.text.length, Math.floor((performance.now() - started) / 28)); setCoachText((current) => ({ ...current, [key]: turn.text.slice(0, count) })); if (count >= turn.text.length && interval) window.clearInterval(interval); }, 20); };
    reveal();
    if ("speechSynthesis" in window) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(turn.text); utterance.onend = () => { if (!cancelled) globalThis.setTimeout(() => void startListening(), COACH_HANDOFF_PAUSE_MS); }; window.speechSynthesis.speak(utterance); } else { globalThis.setTimeout(() => { if (!cancelled) void startListening(); }, Math.max(700, turn.text.length * 28) + COACH_HANDOFF_PAUSE_MS); }
    return () => { cancelled = true; if (interval) window.clearInterval(interval); window.speechSynthesis?.cancel(); };
  }, [active?.id, active?.turns.length, active?.status]);

  useEffect(() => () => { releaseMicrophone(); window.speechSynthesis?.cancel(); }, []);
  const pause = async () => { if (!active) return; stopListening(); const paused = await api<Session>(`/sessions/${active.id}/pause`, { method: "POST" }); setActive(paused); setSessions(sessions.map((s) => s.id === paused.id ? paused : s)); };
  const handleFile = async (file?: File) => { if (!file) return; const form = new FormData(); form.append("file", file); const response = await fetch("/api/resume/upload", { method: "POST", body: form }); setResume((await response.json()).text); };

  return <main>
    <header><div className="brand"><span className="mark">➤</span><div><h1>Beyond the Bullet</h1><p>Be ready to defend every line.</p></div></div><div className="user-menu"><button className="ghost" onClick={() => setShowProfile(!showProfile)}>◉ {profile?.name || "Choose profile"}</button>{showProfile && <div className="popover"><strong>Local profiles</strong>{profiles.map((p) => <button key={p.id} onClick={() => { openProfile(p.id); setShowProfile(false); }}>{p.name}</button>)}{profile && dashboard && <div className="progress-card"><small>PROGRESS</small><strong>{dashboard.bullets.filter((b) => b.status === "complete").length} / {dashboard.bullets.length} bullets practiced</strong><span>{dashboard.facts.length} approved vault facts</span></div>}<button onClick={() => { setProfile(null); setDashboard(null); setResume(""); setName("Candidate"); setSessions([]); setShowProfile(false); }}>＋ New profile</button>{profile && <button className="danger" onClick={deleteProfile}>Delete profile</button>}</div>}</div></header>
    {notice && <div className="notice">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    <section className="workspace"><aside className="panel source-panel"><div className="panel-title"><span>01</span><h2>Your experience</h2></div><label className="upload">Upload resume<input type="file" accept=".txt,.pdf,.docx" onChange={(e) => handleFile(e.target.files?.[0])} /></label><label className="field">Profile name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label className="field">Paste resume or profile text<textarea value={resume} onChange={(e) => setResume(e.target.value)} placeholder="Paste a resume, project notes, or a public profile excerpt..." /></label><button className="primary" disabled={!resume.trim() || busy} onClick={saveProfile}>{busy ? "Parsing..." : "Parse & save profile"}</button>{profile && <><div className="divider"/><div className="panel-title small"><span>02</span><h2>Parsed experiences</h2></div><div className="bullets">{profile.bullets.map((bullet) => <div className="bullet experience-card" key={bullet.id}><span>✦</span><div><strong>{bullet.title || bullet.text}</strong>{bullet.organization && <small>{bullet.organization}{bullet.location ? ` · ${bullet.location}` : ""}</small>}{bullet.dates && <small>{bullet.dates}</small>}{bullet.bullets && bullet.bullets.length > 0 && <ul>{bullet.bullets.map((detail, index) => <li key={`${bullet.id}-${index}`}>{detail}</li>)}</ul>}</div></div>)}</div></>}</aside>
      <section className="panel interview-panel"><div className="panel-title"><span>03</span><h2>Interview room</h2><span className="live">{voiceEnabled ? "● VOICE MODE" : "● TEXT ONLY"}</span></div>{!active ? <div className="empty"><div className="orbit">✈</div><h3>Choose a bullet to explore</h3><p>Each session is grounded in one real experience. The next question responds to what you say.</p><div className="session-list">{sessions.map((s, i) => { const b = profile?.bullets.find((x) => x.id === s.bullet_id); return <button className="session-card" key={s.id} onClick={() => openSession(s)}><span>{String(i + 1).padStart(2, "0")}</span><div><strong>{b?.text}</strong><small>{s.status === "planned" ? "Start focused practice" : s.status === "complete" ? "Play back transcript" : `${s.current_round} rounds · ${s.status}`}</small></div><b>→</b></button>; })}</div></div> : <><div className="anchor"><small>SESSION ANCHOR</small><strong>{selectedBullet?.text}</strong><span>Round {Math.min(active.current_round, active.max_rounds)} of {active.max_rounds}</span></div><div className="conversation">{active.turns.map((turn, i) => { const key = `${active.id}:${i}`; const text = voiceEnabled && turn.role === "agent" ? (coachText[key] ?? "") : turn.text; return <div className={`turn ${turn.role}`} key={`${i}-${turn.text}`}><div className="avatar">{turn.role === "agent" ? "➤" : "You"}</div><div><small>{turn.role === "agent" ? "COACH" : "YOU"}</small><p>{text}</p></div></div>; })}{active.status === "complete" && <div className="feedback"><h3>Session reflection</h3><p>{active.feedback.next_step}</p><div className="feedback-grid"><div><small>STRENGTH</small><p>{active.feedback.strengths?.join(" ")}</p></div><div><small>KEEP EXPLORING</small><p>{active.feedback.gaps?.join(" ")}</p></div></div></div>}</div>{active.status === "active" && <div className="composer"><textarea value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAnswer(); } }} placeholder={voiceEnabled ? "Your live transcript will appear here..." : "Type your answer..."}/><div className="composer-actions"><span className="talking">● {voiceEnabled ? (listening ? "Microphone listening" : "Coach speaking") : "Text conversation is active"}</span>{voiceEnabled ? <button className="primary compact" onClick={() => sendAnswer()} disabled={busy || !answer.trim()}>Finish answer →</button> : <><button className="ghost" onClick={pause}>Pause</button><button className="primary compact" onClick={() => sendAnswer()} disabled={busy || !answer.trim()}>Send answer →</button></>}</div></div>}{active.status === "paused" && <button className="primary" onClick={() => start(active)}>Resume interview</button>}</>}
      </section>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
