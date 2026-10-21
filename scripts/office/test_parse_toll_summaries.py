import hashlib
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("parse_toll_summaries.py")
SPEC = importlib.util.spec_from_file_location("parse_toll_summaries", MODULE_PATH)
PARSER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PARSER
SPEC.loader.exec_module(PARSER)


def source(body: str, name: str = "sample.pdf") -> tuple[str, Path, str, int]:
    path = Path(tempfile.gettempdir()) / name
    return body.strip() + "\n", path, hashlib.sha256(body.encode()).hexdigest(), 1


class TollSummaryParserTest(unittest.TestCase):
    def test_invoice_index_accepts_spaced_invoice_amount_and_builds_manifest(self):
        text = """
收费公路通行费电子票据汇总单
（按票据索引）
汇总单号: 1234567890123456  开票申请日期: 2026-01-06
车牌号码 粤A12345 交易金额 ¥12.30 购买方名称 示例科技有限公司
行程数量 1 票据数量 2 纳税人识别号 91440000TEST000001
票据信息 行程信息
                                    1 20260105 示例站 2.30 12.30
1 * 1234567890123456789010.00 3% 0.29
2 * 22345678901234567890 2.30 3% 0.07
共2张票据 ¥12.30 共1段行程 ¥12.30
"""
        doc = PARSER.parse_document(*source(text))
        self.assertEqual(doc["layout"], "invoice_index")
        self.assertEqual(doc["daily"], {"2026-01-05": PARSER.Decimal("12.30")})
        manifest = PARSER.build_manifest([doc, doc])
        self.assertEqual(len(manifest["expenses"]), 1)  # duplicate source hash is ignored
        self.assertEqual(len(manifest["invoices"]), 2)
        self.assertEqual(manifest["expenses"][0]["daily_amounts"], [{"date": "2026-01-05", "amount": 12.3}])
        self.assertEqual(
            manifest["expenses"][0]["evidence"],
            {"toll": [str(Path(tempfile.gettempdir(), "sample.pdf").resolve())]},
        )

    def test_trip_index_layout_splits_multiple_business_dates(self):
        text = """
收费公路通行费电子票据汇总单
（按行程索引）
汇总单号: 9876543210987654  开票申请日期: 2026/02/04
车牌号码 京B54321 交易金额 ￥30.00 购买方名称 示例服务有限公司
行程数量 3 票据数量 1 纳税人识别号 91110000TEST000002
行程信息 票据信息
1 20260201 甲站 至 乙站 8.00 8.00 1 * 3234567890123456789030.00 3% 0.87
2 20260202 乙站 至 丙站 12.00 12.00
3 20260202 丙站 至 丁站 10.00 10.00
共3段行程 ￥30.00 共1张票据 ￥30.00 ￥0.87
"""
        doc = PARSER.parse_document(*source(text, "renamed-input.pdf"))
        self.assertEqual(doc["layout"], "trip_index")
        self.assertEqual(
            doc["daily"],
            {"2026-02-01": PARSER.Decimal("8.00"), "2026-02-02": PARSER.Decimal("22.00")},
        )
        manifest = PARSER.build_manifest([doc])
        expenses = manifest["expenses"]
        self.assertEqual(len(expenses), 2)
        self.assertEqual([x["date"] for x in expenses], ["2026-02-01", "2026-02-02"])
        self.assertEqual([x["toll"] for x in expenses], [8.0, 22.0])
        self.assertEqual(sum(x["toll"] for x in expenses), 30.0)
        self.assertEqual(len(manifest["invoices"]), 1)  # allocation never duplicates invoices
        self.assertEqual(len(manifest["receipt_attachments"]), 1)
        for expense in expenses:
            self.assertEqual(expense["business_dates"], [expense["date"]])
            self.assertEqual(sum(x["amount"] for x in expense["daily_amounts"]), expense["toll"])
            self.assertEqual(expense["parking"], "")  # no parking evidence is not proof of zero
            self.assertEqual(expense["evidence"], {"toll": [str(Path(tempfile.gettempdir(), "renamed-input.pdf").resolve())]})
        self.assertNotEqual(expenses[0]["id"], expenses[1]["id"])

    def test_ambiguous_or_nonclosing_input_is_rejected(self):
        base = """
收费公路通行费电子票据汇总单
（按票据索引）
汇总单号: 1111222233334444 开票申请日期: 2026-03-02
车牌号码 沪C10000 交易金额 ¥5.00 购买方名称 示例有限公司
行程数量 1 票据数量 1 纳税人识别号 91310000TEST000003
                              1 20260301 某站 5.00 4.00
1 * 423456789012345678905.00 3% 0.15
共1张票据 ¥5.00 共1段行程 ¥5.00
"""
        with self.assertRaisesRegex(PARSER.ParseError, "trip amounts do not close"):
            PARSER.parse_document(*source(base, "bad-total.pdf"))
        ambiguous = base.replace("（按票据索引）", "（按票据索引）（按行程索引）")
        with self.assertRaisesRegex(PARSER.ParseError, "ambiguous"):
            PARSER.parse_document(*source(ambiguous, "ambiguous.pdf"))


if __name__ == "__main__":
    unittest.main()
