import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./markdown.js";
import { htmlToMarkdown } from "./world-export.js";

describe("markdownToHtml", () => {
  it("wraps prose in a paragraph and converts emphasis", () => {
    expect(markdownToHtml("Hello **world** & *moon*")).toBe(
      "<p>Hello <strong>world</strong> &amp; <em>moon</em></p>",
    );
  });

  it("converts headings and lists", () => {
    expect(markdownToHtml("## Title\n\nBody")).toBe("<h2>Title</h2>\n<p>Body</p>");
    expect(markdownToHtml("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(markdownToHtml("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("converts links and inline code", () => {
    expect(markdownToHtml("[link](https://x.test)")).toBe(
      '<p><a href="https://x.test">link</a></p>',
    );
    expect(markdownToHtml("use `npm test`")).toBe("<p>use <code>npm test</code></p>");
  });

  it("converts a GFM pipe table to a real <table>", () => {
    const md = ["| Roll | Result |", "| --- | --- |", "| 1-2 | Wolf |", "| 3-4 | Bear |"].join("\n");
    expect(markdownToHtml(md)).toBe(
      "<table><thead><tr><th>Roll</th><th>Result</th></tr></thead>" +
        "<tbody><tr><td>1-2</td><td>Wolf</td></tr><tr><td>3-4</td><td>Bear</td></tr></tbody></table>",
    );
  });

  it("escapes text so authored markdown cannot inject live HTML", () => {
    const out = markdownToHtml("The AC < 15 <img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).toContain("AC &lt; 15");
  });

  it("returns empty for empty / whitespace input", () => {
    expect(markdownToHtml("")).toBe("");
    expect(markdownToHtml("   \n  ")).toBe("");
  });

  it("round-trips with htmlToMarkdown for the common constructs", () => {
    for (const md of [
      "Hello **world** & *moon*",
      "## Title\n\nBody",
      "- a\n- b",
      "Intro paragraph.\n\n- one\n- two",
      "[link](https://x.test)",
    ]) {
      expect(htmlToMarkdown(markdownToHtml(md))).toBe(md);
    }
  });
});
