package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTeamPageTruncatesOnlyAtItemBoundary(t *testing.T) {
	items := []string{strings.Repeat("a", 8000), strings.Repeat("b", 8000), "third"}
	page, _, err := fitTeamPage(RequestActor{}, items, nil, func(i int) (string, error) { return items[i][:1], nil }, func(i int, c string) map[string]any { return nil })
	if err != nil || len(page.Items) != 1 || page.Items[0] != items[0] || page.NextCursor == nil || *page.NextCursor != "a" {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}

func TestTeamOversizeItemReturnsUsefulMCPFailure(t *testing.T) {
	f := newEntryFixture(t)
	var definitions []sdk.Tool
	if err := json.Unmarshal(teamToolsJSON, &definitions); err != nil {
		t.Fatal(err)
	}
	var tool sdk.Tool
	for _, d := range definitions {
		if d.Name == "team_list" {
			tool = d
			break
		}
	}
	if tool.Name == "" {
		t.Fatal("team_list missing")
	}
	err := f.entry.RegisterTool(&tool, BudgetControl, func(_ context.Context, actor RequestActor, _ json.RawMessage) (ToolResult, error) {
		_, facts, err := fitTeamPage(actor, []string{strings.Repeat("x", teamListBudget)}, nil, func(int) (string, error) { return "after-item", nil }, func(_ int, c string) map[string]any { return teamItemReadReference("team", unknownTeam, "", "", c) })
		return facts, err
	})
	if err != nil {
		t.Fatal(err)
	}
	c := f.client(t, "2025-11-25", "alice")
	result, err := c.CallTool(context.Background(), &sdk.CallToolParams{Name: "team_list", Arguments: map[string]any{}})
	if err != nil || !result.IsError {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	raw, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Error struct {
			Code    string         `json:"code"`
			Message string         `json:"message"`
			Refs    map[string]any `json:"refs"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Error.Code != "payload_too_large" || !strings.Contains(got.Error.Message, "page cannot be returned") || got.Error.Refs["teamId"] != unknownTeam {
		t.Fatalf("failure=%s", raw)
	}
}

func TestTeamBusinessBodyLimitAndVersion(t *testing.T) {
	base := api.CreateTeamRequest{ExpectedUserID: "account"}
	encoded, _ := json.Marshal(base)
	base.Name = strings.Repeat("x", httpx.MaxJSONBody-len(encoded))
	if err := checkTeamBody(base); err != nil {
		t.Fatalf("exact limit: %v", err)
	}
	base.Name += "x"
	if err := checkTeamBody(base); err == nil {
		t.Fatal("oversized business body accepted")
	}
	// These characters remain unescaped in the CLI's JSON.stringify output.
	for _, text := range []string{strings.Repeat("<>&", 200000), strings.Repeat("\u2028", 200000), strings.Repeat("\u2029", 200000)} {
		base.Name = text
		if err := checkTeamBody(base); err != nil {
			t.Fatalf("valid JSON.stringify input rejected: %v", err)
		}
	}
	// An actual backslash-u sequence is escaped by JSON.stringify and counts as
	// seven bytes, rather than as one three-byte Unicode character.
	base.Name = strings.Repeat(`\u2028`, 150000)
	if err := checkTeamBody(base); err == nil {
		t.Fatal("escaped literal over limit accepted")
	}

	old := "9"
	if _, err := observedVersion(&old, 10); err == nil {
		t.Fatal("stale version accepted")
	}
	huge := "9223372036854775808"
	if _, err := observedVersion(&huge, 10); err == nil {
		t.Fatal("overflow accepted")
	}
	if v, err := observedVersion(nil, 10); err != nil || v != 10 {
		t.Fatalf("default version=%d, %v", v, err)
	}
}
