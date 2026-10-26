import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { WORKBOOK_SUPPORT_PYTHON } from "../workbook/script.js";
import { OFFICE_PRESENTATION_PYTHON } from "./presentationScript.js";
import { OFFICE_REVISION_PYTHON } from "./revisionScript.js";

const scalar = z.union([z.string().max(8000), z.number().finite(), z.null()]);
const operations = z
  .array(
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("replace_text"),
          find: z.string().min(1).max(8000),
          replace: z.string().max(8000),
          expectedOccurrences: z.literal(1).default(1),
          paragraph: z.number().int().min(1).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("append_section"),
          heading: z.string().min(1).max(200),
          paragraphs: z.array(z.string().max(8000)).min(1).max(30),
          numbered: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("set_table_cell"),
          table: z.number().int().min(1),
          row: z.number().int().min(1),
          column: z.number().int().min(1),
          expected: z.string().max(8000),
          value: z.string().max(8000),
        })
        .strict(),
      z
        .object({
          kind: z.literal("set_cell"),
          sheet: z.string().min(1).max(31),
          cell: z.string().regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/),
          expected: scalar,
          value: scalar,
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(32);

export const revisionTool = {
  name: "revise_office_document",
  description:
    "NARROW in-place DOCX/XLSX changes with current SHA guard and atomic versioned commit. First inspect_office_document/read_document (or inspect_workbook) to identify actual text/cells. DOCX replace_text changes exactly ONE match, preserving surrounding runs; optional paragraph selects the 1-based body paragraph from inspection. Repeated text requires an explicit paragraph or a larger unique exact match; multiple locations use separate operations. append_section creates a real Heading1 and returns its actual heading/index (never claim a guessed chapter). set_table_cell uses physical 1-based table/row/cell indices from inspection and exact expected text. XLSX set_cell uses existing sheet/address and exact current value, preserves formats/merges/other sheets; formulas are freshly recalculated with the existing bounded Decimal evaluator or the operation fails without overwriting. Verified quotes/source catalogs cannot be edited; source changes require fresh retrieval/generation. Returns actual saved inspection, changed locations, version, preview/download links. No outputPath: edits the requested original, with history retained. Copy the returned receipt verbatim rather than inventing file/section/version claims.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["replace_text", "append_section", "set_table_cell", "set_cell"],
            },
            find: { type: "string" },
            replace: { type: "string" },
            expectedOccurrences: { type: "integer", minimum: 1, maximum: 100 },
            heading: { type: "string" },
            paragraphs: { type: "array", items: { type: "string" } },
            numbered: { type: "boolean" },
            table: { type: "integer", minimum: 1 },
            row: { type: "integer", minimum: 1 },
            column: { type: "integer", minimum: 1 },
            sheet: { type: "string" },
            cell: { type: "string" },
            expected: { type: ["string", "number", "null"] },
            value: { type: ["string", "number", "null"] },
          },
          required: ["kind"],
        },
      },
    },
    required: ["path", "expectedSha256", "operations"],
  },
};
export const inspectionTool = {
  name: "inspect_office_document",
  description:
    "Read CURRENT DOCX headings, paragraphs and physical tables/cells, or XLSX sheets/formulas/source counts, with actual SHA. Use before narrow edits. Reports actual structure, never inferred page counts or claims of completion.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

const main = String.raw`
try:
    request=json.load(sys.stdin);content=base64.b64decode(request['content'],validate=True)
    if len(content)>25*1024*1024:raise ValueError('OFFICE_REVISION_LIMIT_25MB')
    if request['mode']=='inspect':result,_,_=inspect_office(content,request['format']);output=None
    else:output,result=revise_office(content,request['format'],request['operations'])
    print(json.dumps({'result':result,'output':base64.b64encode(output).decode() if output else None},ensure_ascii=False))
except Exception as error:
    code=error.code if isinstance(error,WorkbookError) else str(error) if isinstance(error,ValueError) else type(error).__name__
    print(json.dumps({'error':'OFFICE_REVISION_FAILED','reason':code[:200]}));sys.exit(2)
`;
async function run(
  mode: "inspect" | "revise",
  filename: string,
  bytes: Buffer,
  changes?: unknown,
): Promise<{ result: Record<string, unknown>; bytes?: Buffer }> {
  const format = path.extname(filename).slice(1).toLowerCase();
  if (!["docx", "xlsx"].includes(format)) throw new Error("OFFICE_REVISION_DOCX_XLSX_REQUIRED");
  if (bytes.length > 25 * 1024 * 1024) throw new Error("OFFICE_REVISION_LIMIT_25MB");
  const parsed = mode === "revise" ? operations.safeParse(changes) : undefined;
  if (parsed && !parsed.success)
    throw new Error(
      "OFFICE_REVISION_ARGUMENT_INVALID " +
        parsed.error.issues
          .map((issue) => issue.path.join(".") + ": " + issue.message)
          .join("; ")
          .slice(0, 800),
    );
  const interpreter =
    process.env.ZHENWORK_OFFICE_PYTHON?.trim() || "/opt/zhenwork-office/bin/python";
  if (!path.isAbsolute(interpreter) || interpreter.includes("\0"))
    throw new Error("OFFICE_PYTHON_PATH_INVALID");
  return new Promise((resolve, reject) => {
    const child = execFile(
      interpreter,
      [
        "-c",
        WORKBOOK_SUPPORT_PYTHON +
          "\n" +
          OFFICE_PRESENTATION_PYTHON +
          "\n" +
          OFFICE_REVISION_PYTHON +
          "\n" +
          main,
      ],
      {
        timeout: 20000,
        maxBuffer: 38 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" },
      },
      (error, stdout) => {
        try {
          const response = JSON.parse(stdout);
          if (error || response.error)
            return reject(
              new Error("OFFICE_REVISION_FAILED: " + String(response.reason || "execution failed")),
            );
          resolve({
            result: response.result,
            bytes: response.output ? Buffer.from(response.output, "base64") : undefined,
          });
        } catch {
          reject(new Error("OFFICE_REVISION_UNAVAILABLE"));
        }
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(
      JSON.stringify({
        mode,
        format,
        content: bytes.toString("base64"),
        operations: parsed?.success ? parsed.data : undefined,
      }),
    );
  });
}
export async function inspectOfficeStructure(filename: string, bytes: Buffer) {
  return (await run("inspect", filename, bytes)).result;
}
export async function reviseOfficeDocument(filename: string, bytes: Buffer, changes: unknown) {
  return run("revise", filename, bytes, changes);
}
