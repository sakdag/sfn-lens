# Eval harness

Python script (Bedrock Nova Micro) that scores diagnosis quality for summary vs raw history.

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
AWS_PROFILE=personal AWS_REGION=eu-north-1 python diagnose.py --limit 6
```

Cost guard: the script refuses to run if the estimated upper bound exceeds `$1.00`.
