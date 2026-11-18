package tag

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// NormalizeNameFilter validates a filter, deduplicates by folded key and retains
// the first display spelling. Names are ordered by key; an empty set uses any.
func NormalizeNameFilter(filter model.TagNameFilter) (model.TagNameFilter, error) {
	if filter.Names == nil || (filter.Match != "any" && filter.Match != "all") {
		return model.TagNameFilter{}, Fault("invalid_tag_name_filter", "Tag name filter requires names and an any or all match mode.", nil)
	}
	byKey := make(map[string]string, len(filter.Names))
	for _, value := range filter.Names {
		name, key, err := Name(value)
		if err != nil {
			return model.TagNameFilter{}, err
		}
		if _, exists := byKey[key]; !exists {
			byKey[key] = name
		}
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	// Valid UTF-8 byte order is Unicode scalar order.
	sort.Strings(keys)
	names := make([]string, 0, len(keys))
	for _, key := range keys {
		names = append(names, byKey[key])
	}
	match := filter.Match
	if len(names) == 0 {
		match = "any"
	}
	return model.TagNameFilter{Names: names, Match: match}, nil
}

// NameFilterKeys returns the sorted comparison keys of a validated filter.
func NameFilterKeys(filter model.TagNameFilter) ([]string, error) {
	filter, err := NormalizeNameFilter(filter)
	if err != nil {
		return nil, err
	}
	keys := make([]string, len(filter.Names))
	for i, name := range filter.Names {
		keys[i] = Fold(name)
	}
	return keys, nil
}

// MatchNameFilter reports whether taskNames satisfy the filter. Both the filter
// and every task name are validated; an empty filter matches every task.
func MatchNameFilter(filter model.TagNameFilter, taskNames []string) (bool, error) {
	filter, err := NormalizeNameFilter(filter)
	if err != nil {
		return false, err
	}
	taskKeys := make(map[string]struct{}, len(taskNames))
	for _, value := range taskNames {
		_, key, err := Name(value)
		if err != nil {
			return false, err
		}
		taskKeys[key] = struct{}{}
	}
	if len(filter.Names) == 0 {
		return true, nil
	}
	matched := 0
	for _, name := range filter.Names {
		if _, ok := taskKeys[Fold(name)]; ok {
			matched++
		}
	}
	if filter.Match == "all" {
		return matched == len(filter.Names), nil
	}
	return matched > 0, nil
}

// NameFilterDigest returns the lowercase SHA-256 of compact UTF-8 JSON
// [match, sortedKeys], with HTML characters left unescaped.
func NameFilterDigest(filter model.TagNameFilter) (string, error) {
	filter, err := NormalizeNameFilter(filter)
	if err != nil {
		return "", err
	}
	keys := make([]string, len(filter.Names))
	for i, name := range filter.Names {
		keys[i] = Fold(name)
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([2]any{filter.Match, keys}); err != nil {
		return "", err
	}
	digest := sha256.Sum256(bytes.TrimSuffix(buf.Bytes(), []byte{'\n'}))
	return hex.EncodeToString(digest[:]), nil
}
