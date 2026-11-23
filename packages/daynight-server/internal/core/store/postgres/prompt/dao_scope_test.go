package prompt_test

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/prompt"
)

func TestDAORejectsInvalidPurposeOrScopeBeforeDatabase(t *testing.T) {
	ctx := context.Background()
	// A nil transaction proves rejection precedes every database operation.
	dao := prompt.NewDAO(nil)
	for _, tc := range []struct {
		name    string
		purpose model.PromptPurpose
		scope   model.PromptScope
	}{
		{"purpose", "invalid", model.PromptScopeUser},
		{"scope", model.PromptPurposeReviewer, "invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			operations := map[string]func() error{
				"metadata": func() error { _, err := dao.PromptMetadata(ctx, tc.purpose, "user", tc.scope, "id"); return err },
				"text":     func() error { _, err := dao.PromptText(ctx, tc.purpose, "user", tc.scope, "id"); return err },
				"resource": func() error { _, err := dao.PromptResource(ctx, tc.purpose, "user", tc.scope, "id"); return err },
				"create":   func() error { _, err := dao.CreatePrompt(ctx, tc.purpose, "user", tc.scope, "id", "text"); return err },
				"update": func() error {
					_, err := dao.UpdatePrompt(ctx, tc.purpose, "user", tc.scope, "id", 2, 1, "text")
					return err
				},
			}
			for name, operation := range operations {
				if err := operation(); err == nil {
					t.Errorf("%s accepted invalid %s", name, tc.name)
				}
			}
		})
	}
}
