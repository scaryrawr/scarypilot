import json
import sys
from pathlib import Path

command, filename, *args = sys.argv[1:]
path = Path(filename)
if command == "set":
    print(args[0])
elif command == "get":
    print(json.loads(path.read_text())["tab"] if path.exists() else "home")
else:
    raise SystemExit("expected set or get")
