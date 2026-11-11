package service

import (
	"context"
	"errors"
	"io"
	"testing"

	imageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/imageconfig"
	configvalue "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	coresession "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestImageValidationComposition(t *testing.T) {
	calls := 0
	c := config.Config{ImageDecoder: imageconfig.Config{NodePath: "/pinned/node", HelperPath: "/pinned/helper", ManifestPath: "/pinned/manifest", TemporaryDirectory: "/private/staging"}}
	failure := errors.New("decoder failed")
	factory := func(got coresession.ImageDecoderConfig) (coresession.ImageDecoder, error) {
		calls++
		if got.NodePath != c.ImageDecoder.NodePath || got.HelperPath != c.ImageDecoder.HelperPath || got.ManifestPath != c.ImageDecoder.ManifestPath || got.TemporaryDirectory != c.ImageDecoder.TemporaryDirectory || got.OnPeakRSS != nil {
			t.Fatalf("decoder dependency identity: %+v", got)
		}
		return func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error) {
			return sp.ValidatedImage{}, failure
		}, nil
	}
	decoder, err := configuredImageDecoder(imageconfig.Config{}, factory)
	if err != nil || decoder != nil || calls != 0 {
		t.Fatal("default configuration started an unconfigured decoder")
	}
	decoder, err = configuredImageDecoder(c.ImageDecoder, factory)
	if err != nil || decoder == nil || calls != 1 {
		t.Fatalf("configured decoder not bound: %v", err)
	}
	if _, err = decoder(context.Background(), nil, 0, ""); !errors.Is(err, failure) {
		t.Fatal("factory decoder was replaced")
	}
	decoder, err = configuredImageDecoder(c.ImageDecoder, func(coresession.ImageDecoderConfig) (coresession.ImageDecoder, error) { return nil, failure })
	var configuration *configvalue.ConfigurationError
	if decoder != nil || !errors.As(err, &configuration) || !errors.Is(err, failure) {
		t.Fatalf("decoder initialization failure lost: %v", err)
	}
}
