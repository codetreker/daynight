package imageconfig

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestImageConfiguration(t *testing.T) {
	c := DefaultConfig()
	if c.Validate() != nil {
		t.Fatal("decoder should be disabled by default")
	}
	values := map[string]string{
		"DAYNIGHT_IMAGE_NODE_PATH":      "/opt/daynight/bin/node",
		"DAYNIGHT_IMAGE_HELPER_PATH":    "/opt/daynight/media/image-validation-helper.js",
		"DAYNIGHT_IMAGE_MANIFEST_PATH":  "/opt/daynight/media/image-validation-manifest.json",
		"DAYNIGHT_IMAGE_TEMP_DIRECTORY": "/var/lib/daynight/image-validation",
	}
	marked := map[string]string{}
	lookup := func(key string) (string, bool) { value, ok := values[key]; return value, ok }
	if err := c.ApplyEnvironment(lookup, func(field, variable string) { marked[field] = variable }); err != nil || c.Validate() != nil || len(marked) != len(values) || c.NodePath != values["DAYNIGHT_IMAGE_NODE_PATH"] || c.HelperPath != values["DAYNIGHT_IMAGE_HELPER_PATH"] || c.ManifestPath != values["DAYNIGHT_IMAGE_MANIFEST_PATH"] || c.TemporaryDirectory != values["DAYNIGHT_IMAGE_TEMP_DIRECTORY"] {
		t.Fatalf("explicit configuration: %+v %v", c, err)
	}
	for field, original := range values {
		for _, invalid := range []string{"", "relative/path", "/absolute/../path", "/absolute/line\nbreak"} {
			values[field] = invalid
			candidate := DefaultConfig()
			if err := candidate.ApplyEnvironment(lookup, nil); err != nil {
				t.Fatal(err)
			}
			var failure *configvalue.ConfigurationError
			if err := candidate.Validate(); !errors.As(err, &failure) || failure.Field != field {
				t.Fatalf("accepted invalid %s: %v", field, err)
			}
		}
		values[field] = original
	}
	original := c
	if err := c.ApplyEnvironment(func(string) (string, bool) { return "ignored", false }, nil); err != nil || c != original {
		t.Fatalf("absent environment changed configuration: %+v %v", c, err)
	}
}
