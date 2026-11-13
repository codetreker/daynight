package watchdog

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestPortableRegexSharedWorkerCorpus(t *testing.T) {
	raw, err := os.ReadFile("testdata/portable-regex.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Pattern  string   `json:"pattern"`
		Accepted bool     `json:"accepted"`
		Matches  []string `json:"matches"`
		Misses   []string `json:"misses"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Pattern, func(t *testing.T) {
			if PortableRegex(tc.Pattern) != tc.Accepted {
				t.Fatalf("admission mismatch: %q", tc.Pattern)
			}
			match, err := json.Marshal(map[string]string{"regex": tc.Pattern})
			if err != nil {
				t.Fatal(err)
			}
			_, err = ValidateRules(nil, rule(string(match)))
			if (err == nil) != tc.Accepted {
				t.Fatalf("manual admission: %v", err)
			}
			if !tc.Accepted {
				return
			}
			r := regexp.MustCompile(tc.Pattern)
			for _, value := range tc.Matches {
				if !r.MatchString(value) {
					t.Fatalf("did not match %q", value)
				}
			}
			for _, value := range tc.Misses {
				if r.MatchString(value) {
					t.Fatalf("matched %q", value)
				}
			}
		})
	}
}

func rule(match string) json.RawMessage {
	if match != "" {
		match = `,"match":` + match
	}
	return json.RawMessage(`[{"id":"resume","category":"stalled","action":{"kind":"send_message","message":"Continue within scope"}` + match + `}]`)
}
func TestRuleBoundary(t *testing.T) {
	valid := string(rule(`{"contains":"Ready","regex":"^Ready.*$","projectIds":["11111111-1111-4111-8111-111111111111"]}`))
	for _, raw := range []string{valid, `[]`, `null`, string(rule("")), string(rule(`{}`))} {
		if _, err := ValidateRules(nil, json.RawMessage(raw)); err != nil {
			t.Fatalf("valid %s: %v", raw, err)
		}
	}
	for _, raw := range []string{
		`{}`, `[`, strings.Replace(valid, `"stalled"`, `"waiting_input"`, 1), strings.Replace(valid, `"send_message"`, `"change_status"`, 1), strings.Replace(valid, `"Continue within scope"`, `" "`, 1), strings.Replace(valid, `"resume"`, `" "`, 1),
		strings.Replace(valid, `"contains"`, `"arbitrary"`, 1), strings.Replace(valid, `"Ready"`, `" "`, 1), strings.Replace(valid, `"^Ready.*$"`, `"["`, 1), strings.Replace(valid, `11111111-1111-4111-8111-111111111111`, `bad`, 1),
		string(rule(`{"projectIds":["00000000-0000-0000-0000-000000000000"]}`)), string(rule(`{"projectIds":["11111111-1111-4111-8111-111111111111","11111111-1111-4111-8111-111111111111"]}`)),
		strings.Replace(valid, `"id"`, `"ID"`, 1), strings.Replace(valid, `"message"`, `"Message"`, 1),
		string(rule(`null`)), string(rule(`{"contains":null}`)), string(rule(`{"regex":null}`)), string(rule(`{"projectIds":null}`)),
		string(rule(`{"Contains":"Ready"}`)),
		valid[:len(valid)-1] + `,` + valid[1:],
	} {
		if _, err := ValidateRules(nil, json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if _, err := ValidateRules(json.RawMessage(`{"unknown":true}`), rule("")); err == nil {
		t.Fatal("invalid prior rules accepted")
	}
}

func TestLegacyEmptyObjectCanBeRepairedWithoutRelaxingNewRules(t *testing.T) {
	for _, legacy := range []string{`{}`, ` { } `} {
		for _, next := range []json.RawMessage{json.RawMessage(`[]`), json.RawMessage(`null`), rule("")} {
			widens, err := ValidateRules(json.RawMessage(legacy), next)
			if err != nil || widens != (string(next) == string(rule(""))) {
				t.Fatalf("repair %s to %s: widens=%v err=%v", legacy, next, widens, err)
			}
		}
		for _, next := range []json.RawMessage{json.RawMessage(`{}`), json.RawMessage(`{"rules":[]}`), json.RawMessage(strings.Replace(string(rule("")), "stalled", "waiting_input", 1))} {
			if _, err := ValidateRules(json.RawMessage(legacy), next); err == nil {
				t.Fatalf("legacy baseline admitted invalid replacement %s", next)
			}
		}
	}
}
func TestPortableRegexBoundary(t *testing.T) {
	for _, value := range []string{`^ready$`, `[a-z]+(one|two)?`, `a{1,4}`, `a\n\r\t\.`, `你好.*`, `[\[\]]`, `a\{b`, `a\}`, `\]`, `[^a]`, `[^^]`, `a{1,}`, `[{}]`} {
		if !PortableRegex(value) {
			t.Fatalf("rejected %s", value)
		}
	}
	for _, value := range []string{`(?i)a`, `(?=a)`, `[[:alpha:]]`, `\d+`, `\p{L}`, `\1`, `\`, `[`, strings.Repeat("a", 1025), "", `a{b`, `a}`, `]`, `[]a]`, `[^]]`} {
		if PortableRegex(value) {
			t.Fatalf("accepted %s", value)
		}
	}
}
func TestWideningPreservesRuleAndMatchBoundaries(t *testing.T) {
	project := `11111111-1111-4111-8111-111111111111`
	cases := []struct {
		name, old, next string
		widens          bool
	}{
		{"same", "", "", false}, {"add condition", "", `{"contains":"ready"}`, false}, {"remove condition", `{"contains":"ready"}`, "", true},
		{"narrow substring", `{"contains":"ready"}`, `{"contains":"ready now"}`, false}, {"broaden substring", `{"contains":"ready now"}`, `{"contains":"ready"}`, true},
		{"same regex", `{"regex":"^ready$"}`, `{"regex":"^ready$"}`, false}, {"changed regex", `{"regex":"^ready$"}`, `{"regex":"ready"}`, true}, {"remove regex", `{"regex":"ready"}`, `{}`, true},
		{"restrict projects", "", `{"projectIds":["` + project + `"]}`, false}, {"same projects", `{"projectIds":["` + project + `"]}`, `{"projectIds":["` + project + `"]}`, false},
		{"all projects", `{"projectIds":["` + project + `"]}`, `{}`, true}, {"expand projects", `{"projectIds":["` + project + `"]}`, `{"projectIds":["` + project + `","22222222-2222-4222-8222-222222222222"]}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ValidateRules(rule(tc.old), rule(tc.next))
			if err != nil || got != tc.widens {
				t.Fatalf("widens=%v err=%v", got, err)
			}
		})
	}
	if wide, err := ValidateRules(nil, rule("")); err != nil || !wide {
		t.Fatal("new rule must widen", wide, err)
	}
	if wide, err := ValidateRules(rule(""), json.RawMessage(`[]`)); err != nil || wide {
		t.Fatal("deleting a rule must narrow", wide, err)
	}
	if wide, err := ValidateRules(rule(""), json.RawMessage(strings.Replace(string(rule("")), "Continue within scope", "Other message", 1))); err != nil || !wide {
		t.Fatal("changed action needs attention", wide, err)
	}
}
func TestPresetStartsReportOnly(t *testing.T) {
	p := Preset("id")
	if p.Application != "watchdog" || p.Takeover != "auto" || p.Kind != "continuous" || string(p.Rules) != "[]" || !strings.Contains(p.Body, "without new evidence") {
		t.Fatalf("bad preset: %#v", p)
	}
}
