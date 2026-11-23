//go:build !linux && !darwin

package local

import "os"

// New staging is disabled on these platforms; preserve legacy cleanup.
func lockArchiveDirectory(*os.File) error   { return nil }
func unlockArchiveDirectory(*os.File) error { return nil }
