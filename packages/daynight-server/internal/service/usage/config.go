package usage

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"os"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func configurationError(field, rule string) error {
	return &configvalue.ConfigurationError{Field: field, Rule: rule}
}

// FromEnvironment derives a purpose-separated key from the existing configured
// S2S signing secret unless an explicit stable usage key is supplied.
func FromEnvironment(database store.UsageStore, sharedKey string) (*Service, error) {
	options, enabled, err := environmentOptions(os.LookupEnv, sharedKey)
	if err != nil || !enabled {
		return nil, err
	}
	return New(database, options)
}
func environmentOptions(lookup func(string) (string, bool), sharedKey string) (Options, bool, error) {
	var options Options
	if raw, present := lookup("DAYNIGHT_USAGE_WRITE_ENABLED"); present {
		switch raw {
		case "true":
			options.WriteEnabled = true
		case "false":
		default:
			return options, false, configurationError("DAYNIGHT_USAGE_WRITE_ENABLED", "must be exactly true or false")
		}
	}
	if raw, present := lookup("DAYNIGHT_USAGE_QUALIFIED_PROFILES"); present && raw != "" {
		options.QualifiedProfiles = strings.Split(raw, ",")
		if _, err := qualificationEntries(options.QualifiedProfiles); err != nil {
			return options, false, err
		}
	}
	if raw, present := lookup("DAYNIGHT_USAGE_CURSOR_KEY"); present {
		key, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || len(key) != 32 || base64.RawURLEncoding.EncodeToString(key) != raw {
			return options, false, configurationError("DAYNIGHT_USAGE_CURSOR_KEY", "must contain canonical unpadded base64url for exactly 32 random bytes")
		}
		options.CursorKey = key
	} else if sharedKey != "" {
		valid := len(sharedKey) >= 32 && len(sharedKey) <= 256
		for _, r := range sharedKey {
			valid = valid && r >= 0x21 && r <= 0x7e
		}
		if !valid {
			return options, false, configurationError("DAYNIGHT_S2S_SHARED_KEY", "must contain 32 through 256 visible ASCII bytes when used for usage cursor signing")
		}
		mac := hmac.New(sha256.New, []byte(sharedKey))
		mac.Write([]byte("daynight.usage.cursor.v1"))
		options.CursorKey = mac.Sum(nil)
	} else {
		if options.WriteEnabled {
			return options, false, configurationError("DAYNIGHT_USAGE_CURSOR_KEY / DAYNIGHT_S2S_SHARED_KEY", "must provide a stable cursor signing key before usage writes are enabled")
		}
		return options, false, nil
	}
	return options, true, nil
}
func qualificationEntries(entries []string) (map[string]bool, error) {
	seen := map[string]bool{}
	for _, entry := range entries {
		id, version, ok := strings.Cut(entry, "@")
		known := false
		for _, p := range core.Profiles() {
			known = known || p.ID == id && p.Provider != "codex"
		}
		if !ok || !known || !core.Text(version, 128) || strings.TrimSpace(version) != version || strings.ContainsAny(version, ",@") || seen[entry] {
			return nil, configurationError("DAYNIGHT_USAGE_QUALIFIED_PROFILES", "must contain unique supported profileId@providerVersion pairs separated by commas")
		}
		seen[entry] = true
	}
	return seen, nil
}
