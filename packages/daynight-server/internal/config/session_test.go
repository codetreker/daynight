package config

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestSessionArchiveLimitsLayers(t *testing.T) {
	root := t.TempDir()
	writeLayer(t, root, "config.yml", validBase)
	c, err := LoadServer(root, lookupValues(nil))
	if err != nil || c.Session.MaxConcurrent != 20 || c.Session.MaxConcurrentPerOwner != 5 {
		t.Fatalf("defaults: %+v %v", c.Session, err)
	}
	writeLayer(t, root, "config.yml", validBase+"session: {archive_max_concurrent: 17, archive_max_concurrent_per_owner: 4}\n")
	writeLayer(t, root, "config.local.yml", "session: {archive_max_concurrent: 11}\n")
	for _, tc := range []struct {
		env             map[string]string
		instance, owner int
	}{
		{nil, 11, 4},
		{map[string]string{"DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT": "7"}, 7, 4},
		{map[string]string{"DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT_PER_OWNER": "2"}, 11, 2},
	} {
		c, err = LoadServer(root, lookupValues(tc.env))
		if err != nil || c.Session.MaxConcurrent != tc.instance || c.Session.MaxConcurrentPerOwner != tc.owner {
			t.Fatalf("layers %v: %+v %v", tc.env, c.Session, err)
		}
	}
}

func TestSessionArchiveLimitsRejectInvalidSources(t *testing.T) {
	for _, field := range []string{"archive_max_concurrent", "archive_max_concurrent_per_owner"} {
		for _, value := range []string{"0", "-1", "null", "''", "1.5", "9223372036854775808"} {
			t.Run(field+"/yaml/"+value, func(t *testing.T) {
				root := t.TempDir()
				writeLayer(t, root, "config.yml", validBase+fmt.Sprintf("session: {%s: %s}\n", field, value))
				_, err := LoadServer(root, lookupValues(nil))
				var f *configvalue.ConfigurationError
				if !errors.As(err, &f) || f.Field != "session."+field || f.Origin.Source != "config.yml" {
					t.Fatalf("invalid YAML error: %v", err)
				}
			})
		}
		env := "DAYNIGHT_SESSION_" + strings.ToUpper(field)
		for _, value := range []string{"", "0", "-1", "+1", " 1", "1.5", "9223372036854775808"} {
			t.Run(field+"/env/"+value, func(t *testing.T) {
				root := t.TempDir()
				writeLayer(t, root, "config.yml", validBase)
				_, err := LoadServer(root, lookupValues(map[string]string{env: value}))
				var f *configvalue.ConfigurationError
				if !errors.As(err, &f) || f.Field != "session."+field || f.Phase != "override" || f.Origin.EnvName != env {
					t.Fatalf("invalid environment error: %v", err)
				}
			})
		}
	}
}
