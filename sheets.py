
import os, json, time
from typing import Dict, Any, List, Optional
import gspread
import pandas as pd

# Thai sheet names (expected)
SHEET_NAMES = [
    "ข้อมูลสินค้าและราคา",
    "บุคลิกน้อง A.I.",
    "FAQ",
    "Intent Instruction – ก่อนขาย",
    "Intent Instruction – หลังการขาย",
    "Training Data",
    "System Config",
    "Promotions",
    "Payment",
    "Orders",
]

class SheetsDB:
    def __init__(self, spreadsheet_id: str, service_account_json: dict, refresh_secs: int = 300):
        self.spreadsheet_id = spreadsheet_id
        self.sa_json = service_account_json
        self.refresh_secs = refresh_secs
        self.client = None
        self.book = None
        self.cache: Dict[str, pd.DataFrame] = {}
        self.last_load = 0.0

    def _connect(self):
        if self.client is None:
            self.client = gspread.service_account_from_dict(self.sa_json)
        if self.book is None:
            self.book = self.client.open_by_key(self.spreadsheet_id)

    def _read_sheet_df(self, name: str) -> pd.DataFrame:
        try:
            ws = self.book.worksheet(name)
            values = ws.get_all_values()
            if not values:
                return pd.DataFrame()
            header = values[0]
            rows = values[1:]
            df = pd.DataFrame(rows, columns=header)
            return df
        except Exception:
            # If sheet doesn't exist, return empty df
            return pd.DataFrame()

    def load(self, force: bool = False) -> Dict[str, pd.DataFrame]:
        now = time.time()
        if (now - self.last_load < self.refresh_secs) and not force and self.cache:
            return self.cache
        self._connect()
        loaded = {}
        for name in SHEET_NAMES:
            loaded[name] = self._read_sheet_df(name)
        self.cache = loaded
        self.last_load = now
        return self.cache

    def get(self, name: str) -> pd.DataFrame:
        if not self.cache:
            self.load()
        return self.cache.get(name, pd.DataFrame())
