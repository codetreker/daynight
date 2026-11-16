package config

import (
	"strings"
	"testing"
)

func TestRetiredGitHubConfigurationIsNotLoaded(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase+"github: {enabled: true, app_id: invalid, private_key_file: missing}\n")
	lookup := lookupValues(nil)
	if _, err := LoadServer(root, func(key string) (string, bool) {
		if strings.HasPrefix(key, "DAYNIGHT_GITHUB_") {
			t.Errorf("retired variable requested: %s", key)
		}
		return lookup(key)
	}); err != nil {
		t.Fatalf("retired settings affected startup: %v", err)
	}
}
