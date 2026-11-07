import { test } from "node:test"
import assert from "node:assert/strict"
import { parseSystemOne, parseVerdict } from "../extensions/classifier.ts"

const answer = (choice: string, confidence: number) => ({ answers: { decision: { choice, confidence } } })

test("systemone confident allow and deny", () => {
  assert.equal(parseSystemOne(answer("allow", 0.95)).decision, "allow")
  assert.equal(parseSystemOne(answer("deny", 0.9)).decision, "deny")
})

test("systemone low confidence escalates", () => {
  assert.equal(parseSystemOne(answer("allow", 0.5)).decision, "escalate")
})

test("systemone malformed escalates", () => {
  assert.equal(parseSystemOne({}).decision, "escalate")
  assert.equal(parseSystemOne(answer("maybe", 0.99)).decision, "escalate")
  assert.equal(parseSystemOne({ answers: { decision: { choice: "allow" } } }).decision, "escalate")
})

test("parses allow and deny", () => {
  assert.equal(parseVerdict('{"decision":"allow","reason":"ok"}').decision, "allow")
  assert.equal(parseVerdict('{"decision":"deny","reason":"bad"}').decision, "deny")
})

test("unknown decision escalates", () => {
  assert.equal(parseVerdict('{"decision":"maybe"}').decision, "escalate")
})

test("no or bad JSON escalates", () => {
  assert.equal(parseVerdict("nope").decision, "escalate")
  assert.equal(parseVerdict("{not json}").decision, "escalate")
})

test("takes the last decision object when several are emitted", () => {
  const text = 'thinking {"decision":"allow","reason":"x"} wait {"decision":"deny","reason":"y"}'
  assert.equal(parseVerdict(text).decision, "deny")
})

test("ignores unrelated JSON objects", () => {
  assert.equal(parseVerdict('{"a":1} {"decision":"allow","reason":"r"}').decision, "allow")
})

test("truncates long reasons", () => {
  const v = parseVerdict(JSON.stringify({ decision: "allow", reason: "x".repeat(1000) }))
  assert.equal(v.reason.length, 300)
})
