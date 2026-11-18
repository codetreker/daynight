package github

import "context"

type discoveryProgress struct {
	pages, candidates, published int
}

func (r *run) withDiscoveryProgress(p discoveryProgress) *run {
	job := *r
	job.log = r.log.With("pages", p.pages, "candidates", p.candidates, "published", p.published)
	return &job
}

func (r *run) discoveryFailure(ctx context.Context, p discoveryProgress, stage string, number int64, cause error) {
	attrs := []any{"phase", "discovery", "stage", stage, "result", "failed"}
	if number != 0 {
		attrs = append(attrs, "number", number)
	}
	attrs = append(attrs, appErrorAttributes(cause)...)
	r.withDiscoveryProgress(p).log.WarnContext(ctx, "github all-state discovery", attrs...)
}
