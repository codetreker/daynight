package sessionprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"unicode/utf16"
)

func markdownSchema() schema {
	return schema{"partId": identifier, "revision": sequence, "textSha256": imageDigest, "complete": boolean, "truncated": boolean, "bindings": func(json.RawMessage) bool { return true }, "retainedImages": func(json.RawMessage) bool { return true }}
}
func validateMarkdown(raw json.RawMessage, textBody string, allowUnknown bool) bool {
	if !validateObject(raw, markdownSchema()) {
		return false
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	hash := sha256.Sum256([]byte(textBody))
	if stringField(m["textSha256"]) != hex.EncodeToString(hash[:]) {
		return false
	}
	ids := map[string]bool{}
	bindings, e := array(m["bindings"])
	if null(m["bindings"]) {
		if !allowUnknown {
			return false
		}
		bindings = nil
	} else if e != nil || len(bindings) > 1000 {
		return false
	}
	bound := len(utf16.Encode([]rune(textBody)))
	last := 0
	for _, binding := range bindings {
		if !validateMarkdownBinding(binding, bound, false, ids) {
			return false
		}
		var b struct{ Start, End int }
		_ = json.Unmarshal(binding, &b)
		units := utf16.Encode([]rune(textBody))
		boundary := func(offset int) bool {
			return offset == 0 || offset == len(units) || !(units[offset] >= 0xdc00 && units[offset] <= 0xdfff && units[offset-1] >= 0xd800 && units[offset-1] <= 0xdbff)
		}
		if !boundary(b.Start) || !boundary(b.End) {
			return false
		}
		if b.Start < last {
			return false
		}
		last = b.End
	}
	retained, e := array(m["retainedImages"])
	if e != nil || len(retained) > 1000 {
		return false
	}
	for _, binding := range retained {
		if !validateMarkdownBinding(binding, 9007199254740991, true, ids) {
			return false
		}
	}
	if string(m["complete"]) == "false" && len(bindings) > 0 {
		return false
	}
	return true
}
func validateMarkdownBinding(raw json.RawMessage, max int, retained bool, ids map[string]bool) bool {
	fields := schema{"imageId": identifier, "start": integerRange(0, max), "end": integerRange(0, max), "part": func(v json.RawMessage) bool {
		var p struct{ Type string }
		_ = json.Unmarshal(v, &p)
		return (p.Type == "image" || p.Type == "image_unavailable") && validateMessagePart(v)
	}}
	if retained {
		fields = extend(fields, schema{"sourceRevision": sequence, "sourceTextSha256": imageDigest, "linkHref": optional(func(v json.RawMessage) bool {
			if !stringValue(v, false, 8192) {
				return false
			}
			u, e := url.Parse(stringField(v))
			return e == nil && u.User == nil && (u.Scheme == "" || u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "mailto")
		})})
	}
	if !validateObject(raw, fields) {
		return false
	}
	var b struct {
		ImageID    string
		Start, End int
		Part       struct{ ImageID string }
	}
	_ = json.Unmarshal(raw, &b)
	if b.Start >= b.End || b.ImageID != b.Part.ImageID || ids[b.ImageID] {
		return false
	}
	ids[b.ImageID] = true
	return true
}
func validateMarkdownPart(raw json.RawMessage) bool {
	fields := extend(markdownSchema(), schema{"type": enum("markdown"), "text": emptyText})
	if !validateObject(raw, fields) {
		return false
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	textBody := stringField(m["text"])
	delete(m, "type")
	delete(m, "text")
	b, _ := json.Marshal(m)
	return validateMarkdown(b, textBody, false)
}
func validateEntryImages(fields map[string]json.RawMessage, kind string, enriched bool) bool {
	imageIDs, partIDs := map[string]bool{}, map[string]bool{}
	projectionError := false
	if enriched {
		if kind != "user_message" && kind != "assistant_message" && kind != "tool_call" && kind != "reasoning" {
			return false
		}
		if !null(fields["imageProjectionError"]) {
			var e ImageError
			_ = json.Unmarshal(fields["imageProjectionError"], &e)
			if e.Code != "source_unavailable" {
				return false
			}
			projectionError = true
		}
	}
	var inspectPart func(json.RawMessage) bool
	inspectPart = func(raw json.RawMessage) bool {
		var p struct {
			Type, ImageID, PartID    string
			Bindings, RetainedImages []json.RawMessage
		}
		_ = json.Unmarshal(raw, &p)
		switch p.Type {
		case "image", "image_unavailable":
			if !enriched || imageIDs[p.ImageID] {
				return false
			}
			imageIDs[p.ImageID] = true
		case "markdown":
			if !enriched || partIDs[p.PartID] {
				return false
			}
			partIDs[p.PartID] = true
			for _, bindings := range [][]json.RawMessage{p.Bindings, p.RetainedImages} {
				for _, binding := range bindings {
					var b struct{ Part json.RawMessage }
					_ = json.Unmarshal(binding, &b)
					if !inspectPart(b.Part) {
						return false
					}
				}
			}
		}
		return true
	}
	if kind == "reasoning" && enriched {
		var raw map[string]json.RawMessage
		_ = json.Unmarshal(fields["markdown"], &raw)
		if !validateMarkdown(fields["markdown"], stringField(fields["text"]), projectionError) {
			return false
		}
		if projectionError != null(raw["bindings"]) {
			return false
		}
		return true
	}
	name := "content"
	if kind == "tool_call" {
		name = "output"
	}
	parts, _ := array(fields[name])
	hasText, emptyMarkdown := false, false
	for _, raw := range parts {
		if !inspectPart(raw) {
			return false
		}
		var p struct {
			Type, Text          string
			Complete, Truncated bool
			Bindings            []json.RawMessage
		}
		_ = json.Unmarshal(raw, &p)
		if p.Type == "text" {
			hasText = true
		}
		if p.Type == "markdown" && p.Text == "" && p.Complete && !p.Truncated && len(p.Bindings) == 0 {
			emptyMarkdown = true
		}
	}
	return !projectionError || hasText && emptyMarkdown
}
