//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestArchiveLimitsStartup(t *testing.T) {
	for _, tc := range []struct {
		name, base, local string
		env               map[string]string
		instance, owner   int
	}{
		{name: "defaults", instance: 20, owner: 5},
		{name: "yaml instance", base: "session: {archive_max_concurrent: 7}\n", instance: 7, owner: 5},
		{name: "yaml owner", base: "session: {archive_max_concurrent_per_owner: 3}\n", instance: 20, owner: 3},
		{name: "local overrides base", base: "session: {archive_max_concurrent: 7, archive_max_concurrent_per_owner: 3}\n", local: "session: {archive_max_concurrent: 9}\n", instance: 9, owner: 3},
		{name: "environment overrides local", base: "session: {archive_max_concurrent: 7, archive_max_concurrent_per_owner: 3}\n", local: "session: {archive_max_concurrent: 9, archive_max_concurrent_per_owner: 4}\n", env: map[string]string{"DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT": "11"}, instance: 11, owner: 4},
		{name: "environment owner", env: map[string]string{"DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT_PER_OWNER": "2"}, instance: 20, owner: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := testStorageRoot(t)
			if tc.base != "" || tc.local != "" {
				if err := os.MkdirAll(filepath.Join(root, "config"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "config", "config.yml"), []byte(tc.base), 0600); err != nil {
					t.Fatal(err)
				}
				if tc.local != "" {
					if err := os.WriteFile(filepath.Join(root, "config", "config.local.yml"), []byte(tc.local), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			values := processAPIEnvironment(t)
			for k, v := range tc.env {
				values[k] = v
			}
			ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
			defer cancel()
			output := &stoppingWriter{stop: cancel}
			code := run(ctx, []string{"--root", root}, lookupTestEnvironment(values), output)
			logs, address := output.snapshot()
			if code != 0 || address == "" {
				t.Fatalf("startup failed: code=%d logs=%s", code, logs)
			}
			var found bool
			for _, line := range strings.Split(logs, "\n") {
				var entry struct {
					Event    string `json:"event"`
					Instance int    `json:"session_archive_max_concurrent"`
					Owner    int    `json:"session_archive_max_concurrent_per_owner"`
				}
				if json.Unmarshal([]byte(line), &entry) == nil && entry.Event == "configuration_loaded" {
					found = true
					if entry.Instance != tc.instance || entry.Owner != tc.owner {
						t.Fatalf("effective limits: %+v", entry)
					}
				}
			}
			if !found {
				t.Fatal("missing configuration_loaded event")
			}
		})
	}
}

func TestArchiveLimitsStartupRejectsInvalid(t *testing.T) {
	for _, tc := range []struct{ name, yaml, variable, value, field string }{
		{"instance zero", "", "DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT", "0", "session.archive_max_concurrent"},
		{"instance empty", "", "DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT", "", "session.archive_max_concurrent"},
		{"owner empty", "", "DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT_PER_OWNER", "", "session.archive_max_concurrent_per_owner"},
		{"owner negative", "", "DAYNIGHT_SESSION_ARCHIVE_MAX_CONCURRENT_PER_OWNER", "-1", "session.archive_max_concurrent_per_owner"},
		{"yaml null", "session: {archive_max_concurrent: null}\n", "", "", "session.archive_max_concurrent"},
		{"yaml zero", "session: {archive_max_concurrent_per_owner: 0}\n", "", "", "session.archive_max_concurrent_per_owner"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := testStorageRoot(t)
			if tc.yaml != "" {
				if err := os.MkdirAll(filepath.Join(root, "config"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "config", "config.yml"), []byte(tc.yaml), 0600); err != nil {
					t.Fatal(err)
				}
			}
			values := testEnvironment(t)
			if tc.variable != "" {
				values[tc.variable] = tc.value
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			var output bytes.Buffer
			if code := run(ctx, []string{"--root", root}, lookupTestEnvironment(values), &output); code != 1 || !strings.Contains(output.String(), tc.field) || strings.Contains(output.String(), `"event":"configuration_loaded"`) {
				t.Fatalf("invalid limit did not stop startup: code=%d logs=%s", code, output.String())
			}
		})
	}
}
