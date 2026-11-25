#!/usr/bin/env python3
"""Find and erase entries of the OpenJarvis long-term memory.

OpenJarvis has no HTTP route to delete a memory, so the bridge calls this small
program with the OpenJarvis virtual environment's Python (see openjarvis.mjs).
It deletes through OpenJarvis's own backend (``SQLiteMemory.delete``), which is
the code that wrote the entry and keeps the full-text index in step with the
table; nothing here edits the database by SQL. The read side is a read-only
SELECT, because the backend can search but does not return document ids.

Every erased entry is appended first to a private log (mode 600) so a mistaken
"forget" can be undone by hand.

    memory_admin.py find   --db FILE --query TEXT [--limit N]
    memory_admin.py delete --db FILE --log FILE ID [ID ...]

Both print one JSON document on stdout. Exit status is 0 unless it could not run.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata

ID = re.compile(r"^[0-9a-fA-F-]{8,64}$")


def norm(text):
    text = unicodedata.normalize("NFD", str(text or ""))
    text = "".join(c for c in text if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def rows(db):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
    try:
        return con.execute("SELECT id, content, source, metadata FROM documents").fetchall()
    finally:
        con.close()


def cmd_find(args):
    tokens = [t for t in norm(args.query).split() if len(t) > 2]
    found = []
    if tokens:
        for doc_id, content, source, metadata in rows(args.db):
            hay = norm(content)
            if all(t in hay for t in tokens):
                found.append({"id": doc_id, "content": content, "source": source, "metadata": metadata})
    print(json.dumps({"matches": found[: args.limit], "total": len(found)}, ensure_ascii=False))


def cmd_delete(args):
    ids = [i for i in args.ids if ID.match(i)]
    if len(ids) != len(args.ids):
        print(json.dumps({"error": "bad id"}))
        return 2
    from openjarvis.tools.storage.sqlite import SQLiteMemory

    by_id = {r[0]: r for r in rows(args.db)}
    memory = SQLiteMemory(args.db)
    deleted = []
    os.makedirs(os.path.dirname(args.log), mode=0o700, exist_ok=True)
    fd = os.open(args.log, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as log:
        for doc_id in ids:
            row = by_id.get(doc_id)
            if row is None:
                continue
            log.write(
                json.dumps(
                    {"id": doc_id, "content": row[1], "metadata": row[3], "forgotten_at": time.time()},
                    ensure_ascii=False,
                )
                + "\n"
            )
            log.flush()
            if memory.delete(doc_id):
                deleted.append(doc_id)
    print(json.dumps({"deleted": deleted}))
    return 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    find = sub.add_parser("find")
    find.add_argument("--db", required=True)
    find.add_argument("--query", required=True)
    find.add_argument("--limit", type=int, default=10)
    delete = sub.add_parser("delete")
    delete.add_argument("--db", required=True)
    delete.add_argument("--log", required=True)
    delete.add_argument("ids", nargs="+")
    args = parser.parse_args()
    if args.cmd == "find":
        return cmd_find(args) or 0
    return cmd_delete(args)


if __name__ == "__main__":
    sys.exit(main())
