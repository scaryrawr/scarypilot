import sys

RECORDS = [{"id": 1, "name": "alpha"}, {"id": 2, "name": "beta"}]

if "--json" in sys.argv:
    print(RECORDS)
else:
    for record in RECORDS:
        print(f"{record['id']}: {record['name']}")
