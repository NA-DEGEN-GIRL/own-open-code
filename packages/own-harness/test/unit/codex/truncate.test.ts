// Ports codex-rs/utils/string/src/truncate/tests.rs and codex-rs/utils/output-truncation/src/truncate_tests.rs.
// Ported from openai/codex (Apache-2.0) @ 8c0f701167
import { describe, expect, test } from "bun:test"
import { Truncate } from "../../../src/codex/truncate/index.js"

const bytes = (limit: number): Truncate.TruncationPolicy => ({ mode: "bytes", limit })
const tokens = (limit: number): Truncate.TruncationPolicy => ({ mode: "tokens", limit })

describe("utils/string truncate", () => {
  test("split_string_works", () => {
    expect(Truncate.splitString("hello world", 5, 5)).toEqual([1, "hello", "world"])
    expect(Truncate.splitString("abc", 0, 0)).toEqual([3, "", ""])
  })

  test("split_string_handles_empty_string", () => {
    expect(Truncate.splitString("", 4, 4)).toEqual([0, "", ""])
  })

  test("split_string_only_keeps_prefix_when_tail_budget_is_zero", () => {
    expect(Truncate.splitString("abcdef", 3, 0)).toEqual([3, "abc", ""])
  })

  test("split_string_only_keeps_suffix_when_prefix_budget_is_zero", () => {
    expect(Truncate.splitString("abcdef", 0, 3)).toEqual([3, "", "def"])
  })

  test("split_string_handles_overlapping_budgets_without_removal", () => {
    expect(Truncate.splitString("abcdef", 4, 4)).toEqual([0, "abcd", "ef"])
  })

  test("split_string_respects_utf8_boundaries", () => {
    expect(Truncate.splitString("😀abc😀", 5, 5)).toEqual([1, "😀a", "c😀"])
    expect(Truncate.splitString("😀😀😀😀😀", 1, 1)).toEqual([5, "", ""])
    expect(Truncate.splitString("😀😀😀😀😀", 7, 7)).toEqual([3, "😀", "😀"])
    expect(Truncate.splitString("😀😀😀😀😀", 8, 8)).toEqual([1, "😀😀", "😀😀"])
  })

  test("truncate_with_token_budget_returns_original_when_under_limit", () => {
    expect(Truncate.truncateMiddleWithTokenBudget("short output", 100)).toEqual(["short output", undefined])
  })

  test("truncate_with_token_budget_reports_truncation_at_zero_limit", () => {
    expect(Truncate.truncateMiddleWithTokenBudget("abcdef", 0)).toEqual(["…2 tokens truncated…", 2])
  })

  test("truncate_middle_tokens_handles_utf8_content", () => {
    const text = "😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n"
    expect(Truncate.truncateMiddleWithTokenBudget(text, 8)).toEqual([
      "😀😀😀😀…8 tokens truncated… line with text\n",
      16,
    ])
  })

  test("truncate_middle_tokens_keeps_partial_characters_out_of_both_ends", () => {
    for (const [input, expected] of [
      ["a😀b😀c", "a…2 tokens truncated…c"],
      ["é中😀é", "é…2 tokens truncated…é"],
      ["😀😀😀", "…2 tokens truncated…"],
    ] as const)
      expect(Truncate.truncateMiddleWithTokenBudget(input, 1)).toEqual([expected, 3])
  })

  test("truncate_middle_bytes_handles_utf8_content", () => {
    expect(Truncate.truncateMiddleChars("😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n", 20)).toBe(
      "😀😀…21 chars truncated…with text\n",
    )
  })

  test("truncate_middle_with_marker_enforces_the_total_byte_limit", () => {
    expect(Truncate.truncateMiddleWithMarker(`head${"x".repeat(100)}tail`, 32, "<truncated>")).toBe(
      "headxxxxxx<truncated>xxxxxxxtail",
    )
  })

  test("truncate_middle_with_marker_preserves_utf8_boundaries", () => {
    expect(Truncate.truncateMiddleWithMarker("head🦀🦀🦀🦀🦀tail", 18, "...")).toBe("head...🦀tail")
  })

  test("truncate_middle_with_marker_returns_input_that_fits", () => {
    expect(Truncate.truncateMiddleWithMarker("short", 5, "...")).toBe("short")
  })

  test("truncate_middle_with_marker_keeps_a_prefix_when_the_marker_does_not_fit", () => {
    expect(Truncate.truncateMiddleWithMarker("🦀abc", 4, "marker")).toBe("🦀")
  })

  test("approximate token counts round UTF-8 bytes up", () => {
    expect(Truncate.approxTokenCount("")).toBe(0)
    expect(Truncate.approxTokenCount("abcde")).toBe(2)
    expect(Truncate.approxTokenCount("😀")).toBe(1)
    expect(Truncate.approxTokenCount("é")).toBe(1)
  })
})

describe("utils/output-truncation", () => {
  test("truncate_mcp_tool_result_borrows_small_result", () => {
    const result: Truncate.CallToolResult = {
      content: [{ type: "text", text: "hello" }],
      structuredContent: { x: 1 },
      isError: false,
      _meta: { k: "v" },
    }
    expect(Truncate.truncateMcpToolResult(result, 1024)).toBe(result)
  })

  test("truncate_mcp_tool_result_compacts_large_result", () => {
    const maxBytes = 1024
    const result: Truncate.CallToolResult = {
      content: [{ type: "text", text: `head\n${'"\\\n'.repeat(5_000)}\ntail` }],
      structuredContent: { x: "y".repeat(5_000) },
      isError: true,
      _meta: { private: `meta-head${"z".repeat(5_000)}meta-tail` },
    }
    const truncated = Truncate.truncateMcpToolResult(result, maxBytes)
    const content = truncated.content[0] as { type: string; text: string }
    expect(truncated).toEqual({ content: [{ type: "text", text: content.text }], isError: true })
    expect(Buffer.byteLength(JSON.stringify(truncated))).toBeLessThanOrEqual(maxBytes)
    expect(content.text).toContain("head")
    expect(content.text).toContain("chars truncated")
    expect(content.text).toContain("meta-tail")
    expect(Truncate.truncateMcpToolResult(truncated, maxBytes)).toBe(truncated)
  })

  test("truncate_bytes_less_than_placeholder_returns_placeholder", () => {
    expect(Truncate.formattedTruncateText("example output", bytes(1))).toBe(
      "Warning: truncated output (original token count: 4)\nTotal output lines: 1\n\n…13 chars truncated…t",
    )
  })

  test("truncate_tokens_less_than_placeholder_returns_placeholder", () => {
    expect(Truncate.formattedTruncateText("example output", tokens(1))).toBe(
      "Warning: truncated output (original token count: 4)\nTotal output lines: 1\n\nex…3 tokens truncated…ut",
    )
  })

  test("truncate_tokens_under_limit_returns_original", () => {
    expect(Truncate.formattedTruncateText("example output", tokens(10))).toBe("example output")
  })

  test("truncate_bytes_under_limit_returns_original", () => {
    expect(Truncate.formattedTruncateText("example output", bytes(20))).toBe("example output")
  })

  test("truncate_tokens_over_limit_returns_truncated", () => {
    expect(
      Truncate.formattedTruncateText("this is an example of a long output that should be truncated", tokens(5)),
    ).toBe(
      "Warning: truncated output (original token count: 15)\nTotal output lines: 1\n\nthis is an…10 tokens truncated… truncated",
    )
  })

  test("truncate_bytes_over_limit_returns_truncated", () => {
    expect(
      Truncate.formattedTruncateText("this is an example of a long output that should be truncated", bytes(30)),
    ).toBe(
      "Warning: truncated output (original token count: 15)\nTotal output lines: 1\n\nthis is an exam…30 chars truncated…ld be truncated",
    )
  })

  test("truncate_bytes_reports_original_line_count_when_truncated", () => {
    expect(
      Truncate.formattedTruncateText(
        "this is an example of a long output that should be truncated\nalso some other line",
        bytes(30),
      ),
    ).toBe(
      "Warning: truncated output (original token count: 21)\nTotal output lines: 2\n\nthis is an exam…51 chars truncated…some other line",
    )
  })

  test("truncate_tokens_reports_original_line_count_when_truncated", () => {
    expect(
      Truncate.formattedTruncateText(
        "this is an example of a long output that should be truncated\nalso some other line",
        tokens(10),
      ),
    ).toBe(
      "Warning: truncated output (original token count: 21)\nTotal output lines: 2\n\nthis is an example o…11 tokens truncated…also some other line",
    )
  })

  test("truncate_middle_bytes_handles_utf8_content", () => {
    expect(Truncate.truncateText("😀😀😀😀😀😀😀😀😀😀\nsecond line with text\n", bytes(20))).toBe(
      "😀😀…21 chars truncated…with text\n",
    )
  })

  test("truncates_across_multiple_under_limit_texts_and_reports_omitted", () => {
    const chunk =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.\n"
    const chunkTokens = Truncate.approxTokenCount(chunk)
    expect(chunkTokens).toBeGreaterThan(0)
    const image: Truncate.ContentItem = { type: "input_image", image_url: "img:mid", detail: "high" }
    const output = Truncate.truncateFunctionOutputItemsWithPolicy(
      [
        { type: "input_text", text: chunk },
        { type: "input_text", text: chunk },
        image,
        { type: "input_text", text: chunk.repeat(10) },
        { type: "input_text", text: chunk },
        { type: "input_text", text: chunk },
      ],
      tokens(chunkTokens * 3),
      () => 0,
    )
    expect(output.length).toBe(5)
    expect(output[0]).toEqual({ type: "input_text", text: chunk })
    expect(output[1]).toEqual({ type: "input_text", text: chunk })
    expect(output[2]).toEqual(image)
    expect(output[3]).toMatchObject({ type: "input_text", text: expect.stringContaining("tokens truncated") })
    expect(output[4]).toMatchObject({ type: "input_text", text: expect.stringContaining("omitted 2 text items") })
  })

  test("truncate_function_output_items_with_policy_discards_empty_text", () => {
    const empties: Array<Truncate.ContentItem> = Array.from({ length: 16_384 }, () => ({
      type: "input_text",
      text: "",
    }))
    for (const policy of [bytes(0), tokens(1)])
      expect(Truncate.truncateFunctionOutputItemsWithPolicy(empties, policy, () => 0)).toEqual([])
    const content: Array<Truncate.ContentItem> = [
      { type: "input_text", text: "caption" },
      { type: "input_image", image_url: "img:one", detail: "high" },
      { type: "input_image", file_id: "file_123", detail: "high" },
      { type: "input_audio", audio_url: "audio:one" },
      { type: "encrypted_content", encrypted_content: "enc_opaque" },
    ]
    for (const policy of [bytes(16), tokens(4)])
      expect(Truncate.truncateFunctionOutputItemsWithPolicy([...empties, ...content], policy, () => 1)).toEqual(content)
  })

  test("formatted_truncate_text_content_items_with_policy_returns_original_under_limit", () => {
    const items: Array<Truncate.ContentItem> = [
      { type: "input_text", text: "alpha" },
      { type: "input_text", text: "" },
      { type: "input_text", text: "beta" },
    ]
    expect(Truncate.formattedTruncateTextContentItemsWithPolicy(items, bytes(32))).toEqual([items, undefined])
  })

  test("formatted_truncate_text_content_items_with_policy_preserves_empty_leading_text_behavior", () => {
    expect(
      Truncate.formattedTruncateTextContentItemsWithPolicy(
        [
          { type: "input_text", text: "" },
          { type: "input_text", text: "abc" },
        ],
        bytes(0),
      ),
    ).toEqual([
      [
        {
          type: "input_text",
          text: "Warning: truncated output (original token count: 1)\nTotal output lines: 1\n\n…3 chars truncated…",
        },
      ],
      1,
    ])
  })

  test("formatted_truncate_text_content_items_with_policy_merges_text_and_appends_media", () => {
    const imageOne: Truncate.ContentItem = { type: "input_image", image_url: "img:one", detail: "high" }
    const audio: Truncate.ContentItem = { type: "input_audio", audio_url: "audio:one" }
    const file: Truncate.ContentItem = { type: "input_image", file_id: "file_123", detail: "high" }
    const imageTwo: Truncate.ContentItem = { type: "input_image", image_url: "img:two", detail: "high" }
    expect(
      Truncate.formattedTruncateTextContentItemsWithPolicy(
        [
          { type: "input_text", text: "abcd" },
          imageOne,
          { type: "input_text", text: "efgh" },
          audio,
          file,
          { type: "input_text", text: "ijkl" },
          imageTwo,
        ],
        bytes(8),
      ),
    ).toEqual([
      [
        {
          type: "input_text",
          text: "Warning: truncated output (original token count: 4)\nTotal output lines: 3\n\nabcd…6 chars truncated…ijkl",
        },
        imageOne,
        audio,
        file,
        imageTwo,
      ],
      4,
    ])
  })

  test("formatted_truncate_text_content_items_with_policy_preserves_encrypted_content", () => {
    const encrypted: Truncate.ContentItem = { type: "encrypted_content", encrypted_content: "enc_opaque" }
    expect(
      Truncate.formattedTruncateTextContentItemsWithPolicy(
        [{ type: "input_text", text: "abcdefgh" }, encrypted],
        bytes(2),
      ),
    ).toEqual([
      [
        {
          type: "input_text",
          text: "Warning: truncated output (original token count: 2)\nTotal output lines: 1\n\na…6 chars truncated…h",
        },
        encrypted,
      ],
      2,
    ])
  })

  test("truncate_function_output_items_with_policy_omits_audio_over_budget", () => {
    const encrypted: Truncate.ContentItem = { type: "encrypted_content", encrypted_content: "enc_opaque" }
    expect(
      Truncate.truncateFunctionOutputItemsWithPolicy(
        [{ type: "input_text", text: "abcdefgh" }, encrypted, { type: "input_audio", audio_url: "audio:one" }],
        bytes(2),
        () => 1,
      ),
    ).toEqual([
      { type: "input_text", text: "a…6 chars truncated…h" },
      encrypted,
      { type: "input_text", text: "[omitted 1 audio items ...]" },
    ])
  })

  test("truncate_function_output_items_with_policy_charges_audio_against_byte_budget", () => {
    const audio: Truncate.ContentItem = { type: "input_audio", audio_url: "audio:one" }
    expect(
      Truncate.truncateFunctionOutputItemsWithPolicy(
        [audio, { type: "input_text", text: "abcdefgh" }],
        bytes(5),
        () => 1,
      ),
    ).toEqual([audio, { type: "input_text", text: Truncate.truncateText("abcdefgh", bytes(1)) }])
  })

  test("formatted_truncate_text_content_items_with_policy_merges_all_text_for_token_budget", () => {
    expect(
      Truncate.formattedTruncateTextContentItemsWithPolicy(
        [
          { type: "input_text", text: "abcdefgh" },
          { type: "input_text", text: "ijklmnop" },
        ],
        tokens(2),
      ),
    ).toEqual([
      [
        {
          type: "input_text",
          text: "Warning: truncated output (original token count: 5)\nTotal output lines: 2\n\nabcd…3 tokens truncated…mnop",
        },
      ],
      5,
    ])
  })

  test("byte_count_conversion_clamps_non_positive_values", () => {
    expect(Truncate.approxTokensFromByteCountI64(-1)).toBe(0)
    expect(Truncate.approxTokensFromByteCountI64(0)).toBe(0)
    expect(Truncate.approxTokensFromByteCountI64(5)).toBe(2)
  })

  test("policies: budgets and the serialization allowance", () => {
    expect(Truncate.byteBudget(tokens(10))).toBe(40)
    expect(Truncate.tokenBudget(bytes(10))).toBe(3)
    expect(Truncate.withSerializationAllowance(tokens(10_000))).toEqual(tokens(12_000))
    expect(Truncate.withSerializationAllowance(bytes(10))).toEqual(bytes(12))
    expect(Truncate.withSerializationAllowance(bytes(7))).toEqual(bytes(9))
  })
})
