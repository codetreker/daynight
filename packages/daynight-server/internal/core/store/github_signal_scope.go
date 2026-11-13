package store

import "context"

// GitHubSignalTransaction atomically routes a broadcast without acquiring Project locks.
// The writer is valid only for the duration of the callback.
type GitHubSignalTransaction interface {
	WriteGitHubSignals(context.Context, func(GitHubSignalWriter) error) (Completion, error)
}
