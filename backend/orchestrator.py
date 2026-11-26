import json
import random
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .llm import LocalLLM
from .models import Profile, ResumeBullet, Session, Turn


class CoachState(TypedDict, total=False):
    profile: Profile
    session: Session
    bullet: ResumeBullet
    answer: str
    question: str
    provider: str
    input_tokens: int
    output_tokens: int


def _bullet_for_session(profile: Profile, session: Session) -> ResumeBullet:
    bullet = next((item for item in profile.bullets if item.id == session.bullet_id), None)
    if not bullet:
        raise ValueError("Session bullet was not found in the profile")
    return bullet


def _opening_prompt(bullet: ResumeBullet) -> str:
    return f"Ask one concise first interview question about this resume history item: {bullet.text}"


def _follow_up_prompt(bullet: ResumeBullet, session: Session) -> str:
    transcript = "\n".join(f"{turn.role}: {turn.text}" for turn in session.turns)
    return f"""You are interviewing a candidate about one resume history section.
Resume section: {bullet.text}
Source-backed bullets: {json.dumps(bullet.bullets)}
Conversation so far:
{transcript}

Ask exactly one natural follow-up question that responds to the latest answer and probes one unresolved detail.
Stay grounded in the resume and candidate answers. Never invent facts. Do not say that you are generating a question.
If the candidate has already explained ownership, implementation, and evidence of outcome clearly, reply with DONE instead of another question."""


async def generate_opening_question(state: CoachState, llm: LocalLLM) -> dict[str, Any]:
    session = state["session"]
    bullet = state["bullet"]
    fallback = "Walk me through this experience in your own words. What did you personally own, and what changed because of your work?"
    question, provider, input_tokens, output_tokens = await llm.complete(_opening_prompt(bullet), fallback)
    session.status = "active"
    session.current_round = 1
    session.turns = [Turn(role="agent", text=question, bullet_id=bullet.id)]
    return {"session": session, "question": question, "provider": provider, "input_tokens": input_tokens, "output_tokens": output_tokens}


async def generate_follow_up(state: CoachState, llm: LocalLLM) -> dict[str, Any]:
    session = state["session"]
    bullet = state["bullet"]
    answer = state["answer"]
    session.turns.append(Turn(role="user", text=answer, bullet_id=session.bullet_id))
    session.covered_topics.extend(
        topic
        for topic in ["personal ownership", "implementation detail", "impact"]
        if topic in answer.lower() and topic not in session.covered_topics
    )
    session.current_round += 1
    fallback = "What is the most important detail about your ownership, decision, or outcome that we have not made concrete yet?"
    question, provider, input_tokens, output_tokens = await llm.complete(_follow_up_prompt(bullet, session), fallback)
    if question.strip().upper() == "DONE" or session.current_round >= session.max_rounds:
        session.status = "complete"
        session.feedback = {
            "strengths": ["Completed a focused explanation."],
            "gaps": ["Add concrete evidence and measurable impact where possible."],
            "next_step": "Approve useful facts to your Experience Vault and revisit the gaps.",
        }
    else:
        session.turns.append(Turn(role="agent", text=question, bullet_id=bullet.id))
        session.unresolved_gaps = ["specific evidence", "tradeoff or constraint"]
    return {"session": session, "question": question, "provider": provider, "input_tokens": input_tokens, "output_tokens": output_tokens}


def build_opening_graph(llm: LocalLLM):
    async def prepare(state: CoachState) -> dict[str, Any]:
        return {"bullet": _bullet_for_session(state["profile"], state["session"])}

    async def generate(state: CoachState) -> dict[str, Any]:
        return await generate_opening_question(state, llm)

    graph = StateGraph(CoachState)
    graph.add_node("prepare", prepare)
    graph.add_node("generate_opening_question", generate)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "generate_opening_question")
    graph.add_edge("generate_opening_question", END)
    return graph.compile()


def build_follow_up_graph(llm: LocalLLM):
    async def prepare(state: CoachState) -> dict[str, Any]:
        return {"bullet": _bullet_for_session(state["profile"], state["session"])}

    async def generate(state: CoachState) -> dict[str, Any]:
        return await generate_follow_up(state, llm)

    graph = StateGraph(CoachState)
    graph.add_node("prepare", prepare)
    graph.add_node("generate_follow_up", generate)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "generate_follow_up")
    graph.add_edge("generate_follow_up", END)
    return graph.compile()


async def start_coach_session(profile: Profile, session: Session, llm: LocalLLM) -> dict[str, Any]:
    return await build_opening_graph(llm).ainvoke({"profile": profile, "session": session})


async def start_random_session(profile: Profile, llm: LocalLLM) -> dict[str, Any]:
    bullet = random.choice(profile.bullets)
    session = Session(profile_id=profile.id, bullet_id=bullet.id, status="planned")
    return await start_coach_session(profile, session, llm)


async def continue_coach_session(profile: Profile, session: Session, answer: str, llm: LocalLLM) -> dict[str, Any]:
    return await build_follow_up_graph(llm).ainvoke({"profile": profile, "session": session, "answer": answer})
