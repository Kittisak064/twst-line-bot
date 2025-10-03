
import re
from typing import List, Dict, Any, Tuple
import pandas as pd

def _norm(s: str) -> str:
    return (s or "").strip().lower()

def parse_detection_rule(rule: str) -> Dict[str, Any]:
    """
    Supported formats:
      - "keyword_any:คีย์เวิร์ด1,คีย์เวิร์ด2|llm"
      - "always:*"
    Returns dict with type and tokens.
    """
    rule = (rule or "").strip()
    parts = rule.split("|")  # ignore "|llm" for now
    core = parts[0]
    if core.startswith("keyword_any:"):
        toks = [t.strip().lower() for t in core.split(":", 1)[1].split(",") if t.strip()]
        return {"type": "keyword_any", "tokens": toks}
    if core.startswith("always"):
        return {"type": "always"}
    return {"type": "unknown"}

def match_keyword_any(text: str, tokens: List[str]) -> bool:
    t = _norm(text)
    return any(tok in t for tok in tokens)

def choose_intent(text: str, df_before: pd.DataFrame, df_after: pd.DataFrame) -> Tuple[str, Dict[str, Any]]:
    """
    Returns (which_sheet, row_dict). which_sheet in {"before","after","fallback"}.
    """
    candidates: List[Tuple[int, str, Dict[str, Any]]] = []  # (priority, which, row_dict)
    for which, df in (("before", df_before), ("after", df_after)):
        if df is None or df.empty:
            continue
        for _, r in df.iterrows():
            prio = int(str(r.get("ลำดับความสำคัญ", "999")) or 999)
            rule = str(r.get("กฎการตรวจจับ", ""))
            parsed = parse_detection_rule(rule)
            ok = False
            if parsed["type"] == "keyword_any":
                ok = match_keyword_any(text, parsed["tokens"])
            elif parsed["type"] == "always":
                ok = True
            if ok:
                candidates.append((prio, which, r.to_dict()))
    if candidates:
        candidates.sort(key=lambda x: x[0])
        _, which, row = candidates[0]
        return which, row
    # fallback: pick fallback row if exists
    for which, df in (("before", df_before), ("after", df_after)):
        if df is None or df.empty: 
            continue
        for _, r in df.iterrows():
            rule = str(r.get("กฎการตรวจจับ",""))
            if rule.startswith("always"):
                return which, r.to_dict()
    return "fallback", {}
