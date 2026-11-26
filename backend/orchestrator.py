import random
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .llm import LocalLLM
from .models import Profile, Session, Turn


class CoachState(TypedDict, total=False):
    profile: Profile
    session: Session
    bullet_id: str
    question: str
    provider: str
    input_tokens: int
    output_tokens: int


def build_coach_graph(llm: LocalLLM):
    async def pick_history(state: CoachState) -> dict[str, Any]:
        profile = state["profile"]
        bullet = random.choice(profile.bullets)
        session = Session(profile_id=profile.id, bullet_id=bullet.id, status="planned")
        return {"session": session, "bullet_id": bullet.id}

    async def generate_opening_question(state: CoachState) -> dict[str, Any]:
        profile = state["profile"]
        bullet = next(item for item in profile.bullets if item.id == state["bullet_id"])
        prompt = f"Ask one concise first interview question about this resume history item: {bullet.text}"
        fallback = "Walk me through this experience in your own words. What did you personally own, and what changed because of your work?"
        question, provider, input_tokens, output_tokens = await llm.complete(prompt, fallback)
        session = state["session"]
        session.status = "active"
        session.current_round = 1
        session.turns = [Turn(role="agent", text=question, bullet_id=bullet.id)]
        return {"session": session, "question": question, "provider": provider, "input_tokens": input_tokens, "output_tokens": output_tokens}

    graph = StateGraph(CoachState)
    graph.add_node("pick_history", pick_history)
    graph.add_node("generate_opening_question", generate_opening_question)
    graph.add_edge(START, "pick_history")
    graph.add_edge("pick_history", "generate_opening_question")
    graph.add_edge("generate_opening_question", END)
    return graph.compile()


async def start_random_session(profile: Profile, llm: LocalLLM) -> dict[str, Any]:
    graph = build_coach_graph(llm)
    return await graph.ainvoke({"profile": profile})

