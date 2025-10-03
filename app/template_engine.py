
import re
from typing import Any, Dict, List

_PATTERN = re.compile(r"{{\s*(.*?)\s*}}")

def _get_by_path(data: Dict[str, Any], path: str):
    """
    Resolve dotted path inside dicts, supporting Thai keys and spaces/parentheses.
    Example: "product.คุณสมบัติ.max_load_kg" or "ข้อความเมื่อหาไม่พบ (Fallback)"
    """
    cur: Any = data
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return ""
    return cur if cur is not None else ""

def render(template: str, context: Dict[str, Any]) -> str:
    def repl(m):
        keypath = m.group(1).strip()
        val = _get_by_path(context, keypath)
        return str(val)
    return _PATTERN.sub(repl, template or "")
