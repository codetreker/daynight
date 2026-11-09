package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func decoderFixture(t *testing.T, body string) ImageDecoderConfig {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	runtime := filepath.Join(dir, "node")
	if err := os.WriteFile(runtime, []byte("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo v24.0.0; exit 0; fi\nexec /bin/sh \"$2\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	helper := filepath.Join(dir, "image-validation-helper.js")
	engine := filepath.Join(dir, "image-validation.js")
	if err := os.WriteFile(helper, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine, []byte("pinned engine"), 0600); err != nil {
		t.Fatal(err)
	}
	sum := func(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
	manifest, _ := json.Marshal(imageDecoderManifest{1, imageValidationBuildID, sum([]byte(body)), sum([]byte("pinned engine"))})
	mf := filepath.Join(dir, "image-validation-manifest.json")
	if err := os.WriteFile(mf, manifest, 0600); err != nil {
		t.Fatal(err)
	}
	return ImageDecoderConfig{NodePath: runtime, HelperPath: helper, ManifestPath: mf, TemporaryDirectory: filepath.Join(dir, "private")}
}
func decoderReply(t *testing.T, sha string, result string, rss string) string {
	t.Helper()
	if result == "" {
		result = `{"mediaType":"image/png","byteLength":"3","sha256":"` + sha + `","width":1,"height":1,"frameCount":1}`
	}
	return "cat >/dev/null\nprintf '%s' '" + `{"version":1,"buildId":"` + imageValidationBuildID + `","result":` + result + `,"error":null}` + "'\nprintf '%s' '" + `{"peakRssBytes":"` + rss + `"}` + "' >&2\n"
}
func TestImageDecoderProcessBoundary(t *testing.T) {
	raw := []byte("png")
	h := sha256.Sum256(raw)
	sha := hex.EncodeToString(h[:])
	t.Run("pinned process metadata and cleanup", func(t *testing.T) {
		c := decoderFixture(t, decoderReply(t, sha, "", "123456"))
		peak := int64(0)
		c.OnPeakRSS = func(n int64) { peak = n }
		decode, err := NewImageDecoder(c)
		if err != nil {
			t.Fatal(err)
		}
		got, err := decode(context.Background(), bytes.NewReader(raw), 3, sha)
		if err != nil || got.Width != 1 || peak != 123456 {
			t.Fatalf("got %#v, peak %d: %v", got, peak, err)
		}
		items, err := os.ReadDir(c.TemporaryDirectory)
		if err != nil || len(items) != 0 {
			t.Fatalf("staging remains: %v %v", items, err)
		}
		for _, tc := range []struct {
			length int64
			digest string
			data   []byte
		}{{0, sha, raw}, {3, "bad", raw}, {3, strings.Repeat("a", 64), raw}, {2, sha, raw}, {10485761, sha, raw}} {
			if _, err := decode(context.Background(), bytes.NewReader(tc.data), tc.length, tc.digest); err == nil {
				t.Fatal("accepted invalid original")
			}
		}
		if err := os.WriteFile(c.HelperPath, []byte("changed"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := decode(context.Background(), bytes.NewReader(raw), 3, sha); err == nil {
			t.Fatal("accepted changed artifact")
		}
	})
	for _, tc := range []struct{ name, body string }{{"process failure", "cat >/dev/null\nexit 2\n"}, {"truncated reply", "cat >/dev/null\nprintf '{'\n"}, {"RSS target", decoderReply(t, sha, "", "536870913")}, {"invalid geometry", decoderReply(t, sha, `{"mediaType":"image/png","byteLength":"3","sha256":"`+sha+`","width":16385,"height":1,"frameCount":1}`, "1")}, {"wrong integrity", decoderReply(t, strings.Repeat("a", 64), "", "1")}, {"output bound", "cat >/dev/null\nwhile :; do printf '0000000000000000000000000000000000000000000000000000000000000000'; done\n"}} {
		t.Run(tc.name, func(t *testing.T) {
			c := decoderFixture(t, tc.body)
			decode, err := NewImageDecoder(c)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if _, err = decode(ctx, bytes.NewReader(raw), 3, sha); err == nil {
				t.Fatal("accepted failed decoder")
			}
		})
	}
	t.Run("cancellation joins process before removing file", func(t *testing.T) {
		c := decoderFixture(t, "cat >/dev/null\nwhile :; do :; done\n")
		decode, err := NewImageDecoder(c)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		start := time.Now()
		if _, err = decode(ctx, bytes.NewReader(raw), 3, sha); err == nil {
			t.Fatal("accepted cancelled decoder")
		}
		if time.Since(start) > 2*time.Second {
			t.Fatal("cancellation did not join promptly")
		}
		items, _ := os.ReadDir(c.TemporaryDirectory)
		if len(items) != 0 {
			t.Fatal("cancelled staging remains")
		}
	})
}
func TestImageDecoderConfigurationFailsClosed(t *testing.T) {
	for _, mutate := range []func(*ImageDecoderConfig){func(c *ImageDecoderConfig) { c.NodePath = "node" }, func(c *ImageDecoderConfig) { c.HelperPath = "relative" }, func(c *ImageDecoderConfig) { c.ManifestPath = "/missing" }, func(c *ImageDecoderConfig) { c.TemporaryDirectory = "relative" }, func(c *ImageDecoderConfig) { _ = os.WriteFile(c.ManifestPath, []byte(`{"version":1}`), 0600) }, func(c *ImageDecoderConfig) { _ = os.WriteFile(c.HelperPath, []byte("changed"), 0600) }, func(c *ImageDecoderConfig) { _ = os.WriteFile(c.NodePath, []byte("#!/bin/sh\necho v22.0.0\n"), 0700) }, func(c *ImageDecoderConfig) { _ = os.MkdirAll(c.TemporaryDirectory, 0755) }} {
		c := decoderFixture(t, "")
		mutate(&c)
		if decode, err := NewImageDecoder(c); err == nil || decode != nil {
			t.Fatal("accepted unsupported configuration")
		}
	}
}

func TestImageDecoderPinsAndStrictReplies(t *testing.T) {
	if strictImageJSON([]byte(`{"version":1} {}`), &struct {
		Version int `json:"version"`
	}{}) == nil {
		t.Fatal("accepted trailing JSON")
	}
	if pinnedImageArtifact("relative", strings.Repeat("a", 64)) == nil || pinnedImageArtifact("/missing", "short") == nil || pinnedImageArtifact("/missing", strings.Repeat("a", 64)) == nil {
		t.Fatal("accepted invalid artifact")
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	large := filepath.Join(dir, "large")
	if err = os.WriteFile(large, make([]byte, 1048577), 0600); err != nil {
		t.Fatal(err)
	}
	if pinnedImageArtifact(large, strings.Repeat("a", 64)) == nil {
		t.Fatal("accepted oversized artifact")
	}
	link := filepath.Join(dir, "link")
	if err = os.Symlink(large, link); err != nil {
		t.Fatal(err)
	}
	if pinnedImageArtifact(link, strings.Repeat("a", 64)) == nil {
		t.Fatal("accepted symbolic artifact")
	}
	raw := []byte("png")
	h := sha256.Sum256(raw)
	sha := hex.EncodeToString(h[:])
	good := decoderReply(t, sha, "", "1")
	for _, body := range []string{
		strings.Replace(good, `"version":1`, `"version":2`, 1),
		strings.Replace(good, `"peakRssBytes":"1"`, `"peakRssBytes":"invalid"`, 1),
		strings.Replace(good, `"peakRssBytes":"1"`, `"different":"1"`, 1),
		strings.Replace(good, `"error":null`, `"error":{}`, 1),
		strings.Replace(good, `"result":{`, `"result":{"extra":1,`, 1),
	} {
		c := decoderFixture(t, body)
		decode, e := NewImageDecoder(c)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = decode(context.Background(), bytes.NewReader(raw), 3, sha); e == nil {
			t.Fatal("accepted invalid decoder reply")
		}
	}
}
