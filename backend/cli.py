import argparse

from .metrics import MetricsDB
from .storage import JsonStore


def delete_all_profiles(confirmed: bool) -> int:
    if not confirmed:
        print("This deletes every local profile, session, fact, transcript, and metrics record.")
        answer = input('Type DELETE to continue: ')
        if answer.strip() != "DELETE":
            print("Cancelled.")
            return 1
    store = JsonStore()
    metrics = MetricsDB()
    profile_count = len(store.all()["profiles"])
    store.clear_all()
    metrics.clear_all()
    print(f"Deleted {profile_count} local profile(s), related sessions, facts, transcripts, and metrics.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m backend.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    delete_command = commands.add_parser("delete-all-profiles", help="Delete all local profiles and related data")
    delete_command.add_argument("--yes", action="store_true", help="Skip the DELETE confirmation prompt")
    args = parser.parse_args()
    if args.command == "delete-all-profiles":
        return delete_all_profiles(args.yes)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
