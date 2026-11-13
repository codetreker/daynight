// Package watchdog owns the monitoring application's manual boundary.
package watchdog

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

const MaxRegexBytes = 1024

var repetition = regexp.MustCompile(`^\{(?:0|[1-9][0-9]*)(?:,(?:0|[1-9][0-9]*)?)?\}`)

type Rule struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Match    *Match `json:"match,omitempty"`
	Action   Action `json:"action"`
}
type Match struct {
	Contains   *string  `json:"contains,omitempty"`
	Regex      *string  `json:"regex,omitempty"`
	ProjectIDs []string `json:"projectIds,omitempty"`
}
type Action struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

func invalid() error {
	return &model.Fault{Code: "invalid_input", Message: "Watchdog rules require unique IDs, stalled/send_message actions and portable text matches."}
}
func text(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}

// PortableRegex excludes engine-specific constructs. Workers use Unicode mode
// and translate the end anchor to a strict end-of-input assertion.
func PortableRegex(value string) bool {
	if len(value) > MaxRegexBytes || !text(value) || strings.Contains(value, "(?") || strings.Contains(value, "[[:") {
		return false
	}
	inClass, firstInClass := false, false
	previousAnchor := false
	classStart := -1
	for i := 0; i < len(value); i++ {
		if value[i] == '\\' {
			previousAnchor = false
			i++
			if i >= len(value) || !strings.ContainsRune(`\.+*?()|[]{}^$nrt`, rune(value[i])) {
				return false
			}
			firstInClass = false
			continue
		}
		if inClass {
			if value[i] == ']' {
				if firstInClass {
					return false
				}
				inClass = false
			} else if value[i] != '^' || i != classStart+1 {
				firstInClass = false
			}
			continue
		}
		// Go accepts repetition of bare anchors; JavaScript Unicode mode does
		// not. A group containing an anchor remains a valid repeatable atom.
		if previousAnchor && strings.ContainsRune(`*+?{`, rune(value[i])) {
			return false
		}
		previousAnchor = value[i] == '^' || value[i] == '$'
		switch value[i] {
		case '[':
			inClass, firstInClass = true, true
			classStart = i
		case ']', '}':
			return false
		case '{':
			quantifier := repetition.FindString(value[i:])
			if quantifier == "" {
				return false
			}
			i += len(quantifier) - 1
		}
	}
	_, err := regexp.Compile(value)
	return err == nil
}

func parse(raw json.RawMessage) ([]Rule, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	if len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '[' {
		return nil, invalid()
	}
	// Struct decoding alone accepts case-insensitive field names. Stored rules
	// retain their JSON spelling, so require the exact schema the Worker reads.
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil {
		return nil, invalid()
	}
	for _, entry := range entries {
		fields, err := jsonobject.Decode(entry, "rule", "id", "category", "match", "action")
		if err != nil {
			return nil, invalid()
		}
		if _, err = jsonobject.Decode(fields["action"], "action", "kind", "message"); err != nil {
			return nil, invalid()
		}
		if match, ok := fields["match"]; ok {
			conditions, err := jsonobject.Decode(match, "match", "contains", "regex", "projectIds")
			if err != nil {
				return nil, invalid()
			}
			for _, value := range conditions {
				if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					return nil, invalid()
				}
			}
		}
	}
	var rules []Rule
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&rules) != nil || !json.Valid(raw) {
		return nil, invalid()
	}
	seen := map[string]bool{}
	for _, r := range rules {
		if !text(r.ID) || seen[r.ID] || r.Category != "stalled" || r.Action.Kind != "send_message" || !text(r.Action.Message) {
			return nil, invalid()
		}
		seen[r.ID] = true
		if r.Match == nil {
			continue
		}
		if r.Match.Contains != nil && !text(*r.Match.Contains) || r.Match.Regex != nil && !PortableRegex(*r.Match.Regex) {
			return nil, invalid()
		}
		projects := map[string]bool{}
		for _, id := range r.Match.ProjectIDs {
			canonical, err := model.CanonicalID(id)
			if err != nil || canonical != id || id == "00000000-0000-0000-0000-000000000000" || projects[id] {
				return nil, invalid()
			}
			projects[id] = true
		}
	}
	return rules, nil
}

func narrower(old, new *Match) bool {
	if old == nil {
		return true
	}
	if new == nil {
		new = &Match{}
	}
	if old.Contains != nil && (new.Contains == nil || !strings.Contains(*new.Contains, *old.Contains)) {
		return false
	}
	// General regular-expression inclusion is not inferred. A changed expression
	// requires user attention even when a human could prove it narrower.
	if old.Regex != nil && (new.Regex == nil || *new.Regex != *old.Regex) {
		return false
	}
	if len(old.ProjectIDs) > 0 {
		if len(new.ProjectIDs) == 0 {
			return false
		}
		allowed := map[string]bool{}
		for _, id := range old.ProjectIDs {
			allowed[id] = true
		}
		for _, id := range new.ProjectIDs {
			if !allowed[id] {
				return false
			}
		}
	}
	return true
}

func ValidateRules(oldRules, newRules json.RawMessage) (bool, error) {
	old, err := parse(oldRules)
	if err != nil {
		// Generic applications previously stored an empty object for report-only
		// manuals. Accept that historical baseline without admitting it as a new
		// rule set or allowing malformed executable rules to bypass validation.
		var legacy map[string]json.RawMessage
		if json.Unmarshal(oldRules, &legacy) != nil || len(legacy) != 0 {
			return false, err
		}
	}
	next, err := parse(newRules)
	if err != nil {
		return false, err
	}
	previous := map[string]Rule{}
	for _, r := range old {
		previous[r.ID] = r
	}
	for _, r := range next {
		before, exists := previous[r.ID]
		if !exists || before.Action != r.Action || !narrower(before.Match, r.Match) {
			return true, nil
		}
	}
	return false, nil
}
