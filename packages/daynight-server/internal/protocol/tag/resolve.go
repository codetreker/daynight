// Package tag owns the bounded tag resolution representation.
package tag

import (
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

const MaxResolveBytes = 512 << 10

type Reference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ResolveResponse struct {
	Items []Reference `json:"items"`
}

// EncodeResolve uses the same representation for admission and HTTP output.
func EncodeResolve(w io.Writer, refs []model.TagReference) (int64, error) {
	response := ResolveResponse{Items: make([]Reference, 0, len(refs))}
	for _, ref := range refs {
		response.Items = append(response.Items, Reference{ID: ref.ID, Name: ref.Name})
	}
	return measure.JSON(w, "tag resolve response", MaxResolveBytes, response, true)
}
