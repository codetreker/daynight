package model

import "testing"

func TestTaskPlatformCompatibility(t *testing.T) {
	platforms := []TaskPlatform{PlatformWindows, PlatformLinux, PlatformMacOS}
	for _, actual := range append(platforms, "", "darwin", "Windows") {
		if PlatformCompatible(nil, actual) != actual.Valid() {
			t.Fatalf("unrestricted compatibility for %q", actual)
		}
		for _, required := range platforms {
			if PlatformCompatible(&required, actual) != (actual.Valid() && required == actual) {
				t.Fatalf("compatibility for required %q and actual %q", required, actual)
			}
		}
	}
}
