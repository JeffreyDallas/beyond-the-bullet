import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Profile = { id: string; name: string; raw_text: string; bullets: { id: string; text: string }[] };
type Session = { id: string; bullet_id: string; status: string; current_round: number; max_rounds: number; turns: { role: string; text: string }[]; feedback: { strengths?: string[]; gaps?: string[]; next_step?: string } };

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
  const [dashboard, setDashboard] = useState<{ bullets: { status: string; practice_count: number }[]; facts: { text: string }[] } | null>(null);
  const selectedBullet = useMemo(() => profile?.bullets.find((b) => b.id === active?.bullet_id), [profile, active]);

  const refreshProfiles = async () => setProfiles(await api<Profile[]>("/profiles"));
  useEffect(() => { refreshProfiles().catch((e) => setNotice(e.message)); }, []);

  const loadDashboard = async (id: string) => setDashboard(await api<{ bullets: { status: string; practice_count: number }[]; facts: { text: string }[] }>(`/profiles/${id}/dashboard`));
  const saveProfile = async () => {
    setBusy(true);
    try {
      const saved = await api<Profile>("/profiles", { method: "POST", body: JSON.stringify({ name, raw_text: resume }) });
      setProfile(saved);
      setSessions(await api<Session[]>(`/profiles/${saved.id}/plan`, { method: "POST" }));
      await loadDashboard(saved.id);
      await refreshProfiles();
      setNotice("Profile parsed. Pick a bullet to begin.");
    } catch (e) { setNotice(String(e)); } finally { setBusy(false); }
  };
  const openProfile = async (id: string) => { const p = await api<Profile>(`/profiles/${id}`); setProfile(p); setName(p.name); setResume(p.raw_text); setSessions(await api<Session[]>(`/profiles/${id}/sessions`)); await loadDashboard(id); };
  const deleteProfile = async () => { if (!profile || !window.confirm(`Delete ${profile.name} and all local practice data?`)) return; await api(`/profiles/${profile.id}`, { method: "DELETE" }); setProfile(null); setDashboard(null); setSessions([]); setResume(""); await refreshProfiles(); setNotice("Profile and related local data deleted."); };
  const start = async (session: Session) => { const result = await api<{ session: Session }>(`/sessions/${session.id}/start`, { method: "POST" }); setActive(result.session); };
  const sendAnswer = async () => { if (!active || !answer.trim()) return; setBusy(true); try { const result = await api<{ session: Session }>(`/sessions/${active.id}/answer`, { method: "POST", body: JSON.stringify({ text: answer }) }); setActive(result.session); setSessions(sessions.map((s) => s.id === result.session.id ? result.session : s)); setAnswer(""); } catch (e) { setNotice(String(e)); } finally { setBusy(false); } };
  const pause = async () => { if (!active) return; const paused = await api<Session>(`/sessions/${active.id}/pause`, { method: "POST" }); setActive(paused); setSessions(sessions.map((s) => s.id === paused.id ? paused : s)); };
  const handleFile = async (file?: File) => { if (!file) return; const form = new FormData(); form.append("file", file); const response = await fetch("/api/resume/upload", { method: "POST", body: form }); setResume((await response.json()).text); };
  const speak = (text: string) => { if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); };
  const listen = () => { const Recognition = (window as Window & { webkitSpeechRecognition?: new () => { lang: string; onresult: (event: { results: { [key: number]: { [key: number]: { transcript: string } } } }) => void; start: () => void } }).webkitSpeechRecognition; if (!Recognition) { setNotice("Speech recognition is not available in this browser. You can still type your answer."); return; } const recognition = new Recognition(); recognition.lang = "en-US"; recognition.onresult = (event) => setAnswer((current) => `${current} ${event.results[0][0].transcript}`.trim()); recognition.start(); };

  return <main>
    <header><div className="brand"><span className="mark">➤</span><div><h1>Beyond the Bullet</h1><p>Be ready to defend every line.</p></div></div><div className="user-menu"><button className="ghost" onClick={() => setShowProfile(!showProfile)}>◉ {profile?.name || "Choose profile"}</button>{showProfile && <div className="popover"><strong>Local profiles</strong>{profiles.map((p) => <button key={p.id} onClick={() => { openProfile(p.id); setShowProfile(false); }}>{p.name}</button>)}{profile && dashboard && <div className="progress-card"><small>PROGRESS</small><strong>{dashboard.bullets.filter((b) => b.status === "complete").length} / {dashboard.bullets.length} bullets practiced</strong><span>{dashboard.facts.length} approved vault facts</span></div>}<button onClick={() => { setProfile(null); setDashboard(null); setResume(""); setName("Candidate"); setSessions([]); setShowProfile(false); }}>＋ New profile</button>{profile && <button className="danger" onClick={deleteProfile}>Delete profile</button>}</div>}</div></header>
    {notice && <div className="notice">{notice}<button onClick={() => setNotice("")}>×</button></div>}
    <section className="workspace">
      <aside className="panel source-panel"><div className="panel-title"><span>01</span><h2>Your experience</h2></div><label className="upload">Upload resume<input type="file" accept=".txt,.pdf,.docx" onChange={(e) => handleFile(e.target.files?.[0])} /></label><label className="field">Profile name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label className="field">Paste resume or profile text<textarea value={resume} onChange={(e) => setResume(e.target.value)} placeholder="Paste a resume, project notes, or a public profile excerpt..." /></label><button className="primary" disabled={!resume.trim() || busy} onClick={saveProfile}>{busy ? "Parsing..." : "Parse & save profile"}</button>{profile && <><div className="divider"/><div className="panel-title small"><span>02</span><h2>Parsed bullets</h2></div><div className="bullets">{profile.bullets.map((bullet) => <div className="bullet" key={bullet.id}><span>✦</span>{bullet.text}</div>)}</div></>}</aside>
      <section className="panel interview-panel"><div className="panel-title"><span>03</span><h2>Interview room</h2><span className="live">● LOCAL</span></div>{!active ? <div className="empty"><div className="orbit">✈</div><h3>Choose a bullet to explore</h3><p>Each session is grounded in one real experience. The next question responds to what you say.</p><div className="session-list">{sessions.map((s, i) => { const b = profile?.bullets.find((x) => x.id === s.bullet_id); return <button className="session-card" key={s.id} onClick={() => start(s)}><span>{String(i + 1).padStart(2, "0")}</span><div><strong>{b?.text}</strong><small>{s.status === "planned" ? "Start focused practice" : `${s.current_round} rounds · ${s.status}`}</small></div><b>→</b></button>; })}</div></div> : <><div className="anchor"><small>SESSION ANCHOR</small><strong>{selectedBullet?.text}</strong><span>Round {Math.min(active.current_round, active.max_rounds)} of {active.max_rounds}</span></div><div className="conversation">{active.turns.map((turn, i) => <div className={`turn ${turn.role}`} key={`${i}-${turn.text}`}><div className="avatar">{turn.role === "agent" ? "➤" : "You"}</div><div><small>{turn.role === "agent" ? "COACH" : "YOU"}</small><p>{turn.text}</p>{turn.role === "agent" && <button className="speak" onClick={() => speak(turn.text)}>◖ Listen</button>}</div></div>)}{active.status === "complete" && <div className="feedback"><h3>Session reflection</h3><p>{active.feedback.next_step}</p><div className="feedback-grid"><div><small>STRENGTH</small><p>{active.feedback.strengths?.join(" ")}</p></div><div><small>KEEP EXPLORING</small><p>{active.feedback.gaps?.join(" ")}</p></div></div></div>}</div>{active.status === "active" && <div className="composer"><textarea value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAnswer(); } }} placeholder="Type your answer..."/><div className="composer-actions"><span className="talking">● Voice controls available</span><button className="ghost" onClick={listen}>◉ Talk</button><button className="ghost" onClick={pause}>Pause</button><button className="primary compact" onClick={sendAnswer} disabled={busy || !answer.trim()}>Send answer →</button></div></div>}{active.status === "paused" && <button className="primary" onClick={() => start(active)}>Resume interview</button>}</>}
      </section>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
