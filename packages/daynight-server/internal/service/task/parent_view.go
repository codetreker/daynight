package task

import "context"

type taskParentViewKey struct{}

// WithTaskParentView binds response admission to the selected relation projection.
func WithTaskParentView(ctx context.Context, enabled bool) context.Context {
	return context.WithValue(ctx, taskParentViewKey{}, enabled)
}

func taskParentView(ctx context.Context) bool {
	enabled, _ := ctx.Value(taskParentViewKey{}).(bool)
	return enabled
}
