package service

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	coresession "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestImageValidationComposition(t *testing.T) {
	calls := 0
	c := config.Config{ImageNodePath: "/pinned/node", ImageHelperPath: "/pinned/helper", ImageManifestPath: "/pinned/manifest", ImageTemporaryDirectory: "/private/staging"}
	failure := errors.New("decoder failed")
	factory := func(got coresession.ImageDecoderConfig) (coresession.ImageDecoder, error) {
		calls++
		if got.NodePath != c.ImageNodePath || got.HelperPath != c.ImageHelperPath || got.ManifestPath != c.ImageManifestPath || got.TemporaryDirectory != c.ImageTemporaryDirectory || got.OnPeakRSS != nil {
			t.Fatalf("decoder dependency identity: %+v", got)
		}
		return func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error) {
			return sp.ValidatedImage{}, failure
		}, nil
	}
	decoder, err := configuredImageDecoder(config.Config{}, factory)
	if err != nil || decoder != nil || calls != 0 {
		t.Fatal("default configuration started an unconfigured decoder")
	}
	decoder, err = configuredImageDecoder(c, factory)
	if err != nil || decoder == nil || calls != 1 {
		t.Fatalf("configured decoder not bound: %v", err)
	}
	if _, err = decoder(context.Background(), nil, 0, ""); !errors.Is(err, failure) {
		t.Fatal("factory decoder was replaced")
	}
	decoder, err = configuredImageDecoder(c, func(coresession.ImageDecoderConfig) (coresession.ImageDecoder, error) { return nil, failure })
	var configuration *config.ConfigurationError
	if decoder != nil || !errors.As(err, &configuration) || !errors.Is(err, failure) {
		t.Fatalf("decoder initialization failure lost: %v", err)
	}
}
