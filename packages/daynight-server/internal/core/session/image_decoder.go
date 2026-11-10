package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

const imageValidationBuildID = "daynight-image-validation-v1-sharp-0.35.5"

// ImageDecoderConfig selects a pinned Node 24 decoder and a private staging root.
// Peak RSS is observed after actual child exit; it is not a hard memory sandbox.
type ImageDecoderConfig struct {
	NodePath           string
	HelperPath         string
	ManifestPath       string
	TemporaryDirectory string
	OnPeakRSS          func(int64)
}
type imageDecoderManifest struct {
	Version      int    `json:"version"`
	BuildID      string `json:"buildId"`
	HelperSHA256 string `json:"helperSha256"`
	EngineSHA256 string `json:"engineSha256"`
}

type imageDecoder struct {
	config        ImageDecoderConfig
	manifest      imageDecoderManifest
	enginePath    string
	decodeTimeout time.Duration
}

type decoderOutput struct {
	mu       sync.Mutex
	bytes    []byte
	overflow bool
}

func (b *decoderOutput) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.bytes)+len(p) > 16384 {
		b.overflow = true
		return 0, errors.New("decoder output exceeds its bound")
	}
	b.bytes = append(b.bytes, p...)
	return len(p), nil
}
func strictImageJSON(data []byte, target any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("extra decoder JSON")
	}
	return nil
}
func pinnedImageArtifact(filename, want string) error {
	if !filepath.IsAbs(filename) || len(want) != 64 || strings.ToLower(want) != want {
		return errors.New("invalid decoder artifact configuration")
	}
	resolved, err := filepath.EvalSymlinks(filename)
	if err != nil || resolved != filename {
		return errors.New("decoder artifact is not a canonical regular file")
	}
	f, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() > 1048576 {
		return errors.New("invalid decoder artifact")
	}
	h := sha256.New()
	if _, err = io.Copy(h, io.LimitReader(f, 1048577)); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != want {
		return errors.New("decoder artifact hash differs")
	}
	return nil
}

// NewImageDecoder fails closed when any packaged component or runtime is absent.
func NewImageDecoder(c ImageDecoderConfig) (ImageDecoder, error) {
	decoder, err := newImageDecoder(c)
	if err != nil {
		return nil, err
	}
	return decoder.decode, nil
}

func newImageDecoder(c ImageDecoderConfig) (*imageDecoder, error) {
	unsupported := func() (*imageDecoder, error) {
		return nil, fault("component_unsupported", "The complete image decoder is unavailable.")
	}
	for _, p := range []string{c.NodePath, c.HelperPath, c.ManifestPath, c.TemporaryDirectory} {
		if !filepath.IsAbs(p) {
			return unsupported()
		}
	}
	manifestFile, err := os.Open(c.ManifestPath)
	if err != nil {
		return unsupported()
	}
	b, readErr := io.ReadAll(io.LimitReader(manifestFile, 16385))
	closeErr := manifestFile.Close()
	if readErr != nil || closeErr != nil || len(b) > 16384 {
		return unsupported()
	}
	var manifest imageDecoderManifest
	if strictImageJSON(b, &manifest) != nil || manifest.Version != 1 || manifest.BuildID != imageValidationBuildID {
		return unsupported()
	}
	engine := filepath.Join(filepath.Dir(c.HelperPath), "image-validation.js")
	if pinnedImageArtifact(c.HelperPath, manifest.HelperSHA256) != nil || pinnedImageArtifact(engine, manifest.EngineSHA256) != nil {
		return unsupported()
	}
	node, err := filepath.EvalSymlinks(c.NodePath)
	if err != nil || node != c.NodePath {
		return unsupported()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	versionCommand := exec.CommandContext(ctx, c.NodePath, "--version")
	var version, versionErrors decoderOutput
	versionCommand.Stdout, versionCommand.Stderr = &version, &versionErrors
	err = versionCommand.Run()
	cancel()
	if err != nil || version.overflow || versionErrors.overflow || len(version.bytes) > 128 || !strings.HasPrefix(strings.TrimSpace(string(version.bytes)), "v24.") {
		return unsupported()
	}
	if err = os.MkdirAll(c.TemporaryDirectory, 0700); err != nil {
		return unsupported()
	}
	st, err := os.Lstat(c.TemporaryDirectory)
	if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0077 != 0 {
		return unsupported()
	}
	return &imageDecoder{config: c, manifest: manifest, enginePath: engine, decodeTimeout: 15 * time.Second}, nil
}

func (d *imageDecoder) decode(parent context.Context, src io.Reader, length int64, digest string) (sp.ValidatedImage, error) {
	c := d.config
	var empty sp.ValidatedImage
	if err := parent.Err(); err != nil {
		return empty, err
	}
	if length < 1 || length > 10485760 || len(digest) != 64 || strings.ToLower(digest) != digest {
		return empty, fault("invalid_image", "Image original integrity is invalid.")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return empty, fault("invalid_image", "Image original integrity is invalid.")
	}
	if err := pinnedImageArtifact(c.HelperPath, d.manifest.HelperSHA256); err != nil {
		return empty, fault("component_unsupported", "The complete image decoder is unavailable.")
	}
	if err := pinnedImageArtifact(d.enginePath, d.manifest.EngineSHA256); err != nil {
		return empty, fault("component_unsupported", "The complete image decoder is unavailable.")
	}
	dir, err := os.MkdirTemp(c.TemporaryDirectory, "image-decode-")
	if err != nil {
		return empty, err
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "original")
	f, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return empty, err
	}
	h := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(src, length+1))
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := parent.Err(); err != nil {
		return empty, errors.Join(err, copyErr, syncErr, closeErr)
	}
	if copyErr != nil {
		return empty, copyErr
	}
	if syncErr != nil {
		return empty, syncErr
	}
	if closeErr != nil {
		return empty, closeErr
	}
	if n != length || hex.EncodeToString(h.Sum(nil)) != digest {
		return empty, fault("image_integrity", "Image original integrity differs.")
	}
	if err = os.Chmod(file, 0400); err != nil {
		return empty, err
	}
	ctx, cancel := context.WithTimeout(parent, d.decodeTimeout)
	defer cancel()
	request := struct {
		Version            int    `json:"version"`
		Policy             string `json:"policy"`
		InputPath          string `json:"inputPath"`
		ExpectedByteLength string `json:"expectedByteLength"`
		ExpectedSHA256     string `json:"expectedSha256"`
	}{1, "image-validation-v1", file, strconv.FormatInt(length, 10), digest}
	input, _ := json.Marshal(request)
	cmd := exec.CommandContext(ctx, c.NodePath, "--max-old-space-size=256", c.HelperPath)
	cmd.Stdin = bytes.NewReader(input)
	cmd.Env = append(os.Environ(), "VIPS_CONCURRENCY=1", "UV_THREADPOOL_SIZE=1")
	var stdout, stderr decoderOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	// Run waits for process exit and both pipe-copy goroutines before files or slots are returned.
	err = cmd.Run()
	// A caller disconnect says nothing about the original's validity. Keep
	// that upload recoverable after the child has exited and joined.
	if parent.Err() != nil {
		return empty, parent.Err()
	}
	if ctx.Err() != nil {
		return empty, ctx.Err()
	}
	if err != nil || stdout.overflow || stderr.overflow {
		return empty, fault("image_decode_failed", "Complete image decoding did not finish.")
	}
	var metrics struct {
		PeakRSSBytes string `json:"peakRssBytes"`
	}
	if strictImageJSON(stderr.bytes, &metrics) != nil {
		return empty, fault("image_decode_failed", "Image decoder memory observation is unavailable.")
	}
	rss, err := strconv.ParseInt(metrics.PeakRSSBytes, 10, 64)
	if err != nil || rss <= 0 {
		return empty, fault("image_decode_failed", "Image decoder memory observation is unavailable.")
	}
	if c.OnPeakRSS != nil {
		c.OnPeakRSS(rss)
	}
	if rss > 536870912 {
		return empty, fault("image_decode_failed", "Image decoder exceeded its monitored memory target.")
	}
	var reply struct {
		Version int             `json:"version"`
		BuildID string          `json:"buildId"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if strictImageJSON(stdout.bytes, &reply) != nil || reply.Version != 1 || reply.BuildID != d.manifest.BuildID || len(reply.Result) == 0 || bytes.Equal(reply.Result, []byte("null")) || !bytes.Equal(reply.Error, []byte("null")) {
		return empty, fault("image_decode_failed", "Complete image decoding failed.")
	}
	result, err := sp.DecodeValidatedImage(reply.Result)
	if err != nil {
		return empty, fmt.Errorf("invalid decoded image metadata: %w", err)
	}
	if result.ByteLength != strconv.FormatInt(length, 10) || result.SHA256 != digest {
		return empty, fault("image_integrity", "Decoded image original integrity differs.")
	}
	if err := parent.Err(); err != nil {
		return empty, err
	}
	return result, nil
}
