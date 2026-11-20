package usage

import (
	"os"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func configurationError(field, rule string) error {
	return &configvalue.ConfigurationError{Field: field, Rule: rule}
}

// FromEnvironment configures the usage service from its environment.
func FromEnvironment(database store.UsageStore) (*Service, error) {
	options, enabled, err := environmentOptions(os.LookupEnv)
	if err != nil || !enabled {
		return nil, err
	}
	return New(database, options)
}
func environmentOptions(lookup func(string) (string, bool)) (Options, bool, error) {
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
