package tag

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tagprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type Operations interface {
	List(context.Context, model.Principal, string, tagservice.ListInput) (tagservice.Page, error)
	Get(context.Context, model.Principal, string, string) (tagservice.Item, error)
	Create(context.Context, model.Principal, string, string) (tagservice.WriteResult, error)
	Rename(context.Context, model.Principal, string, string, int64, string) (tagservice.WriteResult, error)
	Delete(context.Context, model.Principal, string, string, int64, bool) (tagservice.WriteResult, error)
	Resolve(context.Context, model.Principal, string, []string) ([]model.TagReference, error)
}

type Authentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}

type handler struct {
	operations Operations
	logger     *slog.Logger
}

// RegisterRoutes mounts the authenticated project tag catalog endpoints.
func RegisterRoutes(mux *http.ServeMux, operations Operations, auth Authentication, logger *slog.Logger) {
	h := &handler{operations: operations, logger: logger}
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tags", auth.Require(h.list))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tags", auth.Require(h.create))
	mux.HandleFunc("/api/v1/projects/{projectId}/tags", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tags/resolve", auth.Require(h.resolve))
	for _, method := range []string{"GET", "PATCH", "DELETE"} {
		mux.HandleFunc(method+" /api/v1/projects/{projectId}/tags/resolve", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	}
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tags/{tagId}", auth.Require(h.get))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/tags/{tagId}", auth.Require(h.rename))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/tags/{tagId}", auth.Require(h.delete))
	mux.HandleFunc("/api/v1/projects/{projectId}/tags/{tagId}", auth.Require(func(w http.ResponseWriter, r *http.Request, principal model.Principal) {
		allowed := "GET, HEAD, PATCH, DELETE"
		if r.PathValue("tagId") == "resolve" {
			allowed = "POST"
		}
		httpx.ResourceMethodNotAllowed(logger, allowed)(w, r, principal)
	}))
}

func tagResponse(item tagservice.Item) api.Tag {
	t := item.Tag
	return api.Tag{ID: t.ID, ProjectID: t.ProjectID, Name: t.Name, Version: t.Version, CreatedAt: t.CreatedAt.UTC(), UpdatedAt: t.UpdatedAt.UTC(), Usage: api.TagUsage{Tasks: item.Usage.Tasks, Goals: item.Usage.Goals}}
}

func (h *handler) resource(w http.ResponseWriter, r *http.Request, p model.Principal, withTag bool) (string, string, *slog.Logger, error) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	projectID, err := model.CanonicalID(r.PathValue("projectId"))
	if err != nil {
		return "", "", logger, err
	}
	logger = logger.With("project_id", projectID)
	if !withTag {
		return projectID, "", logger, nil
	}
	tagID, err := model.CanonicalID(r.PathValue("tagId"))
	if err != nil {
		return "", "", logger, err
	}
	return projectID, tagID, logger.With("tag_id", tagID), nil
}

func (h *handler) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	projectID, _, logger, err := h.resource(w, r, p, false)
	if err == nil {
		var valuesErr error
		values, e := httpx.QueryValues(r, "query", "limit", "cursor")
		valuesErr = e
		if valuesErr == nil {
			page, e := httpx.PageValues(values)
			valuesErr = e
			if valuesErr == nil {
				query := values.Get("query")
				if !utf8.ValidString(query) {
					valuesErr = httpx.InvalidInput("query must contain valid Unicode text")
				} else {
					cursor := ""
					if page.Cursor != nil {
						cursor = *page.Cursor
					}
					result, e := h.operations.List(r.Context(), p, projectID, tagservice.ListInput{Query: query, Limit: page.Limit, Cursor: cursor})
					if e == nil {
						out := api.TagPage{Items: make([]api.Tag, 0, len(result.Items)), CatalogEpoch: result.CatalogEpoch, NextCursor: result.NextCursor}
						for _, item := range result.Items {
							out.Items = append(out.Items, tagResponse(item))
						}
						httpx.WriteJSON(w, r, logger, http.StatusOK, out)
						return
					}
					valuesErr = e
				}
			}
		}
		err = valuesErr
	}
	writeError(w, r, logger, "list", err)
}

func (h *handler) get(w http.ResponseWriter, r *http.Request, p model.Principal) {
	projectID, tagID, logger, err := h.resource(w, r, p, true)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	if err == nil {
		var item tagservice.Item
		item, err = h.operations.Get(r.Context(), p, projectID, tagID)
		if err == nil {
			httpx.WriteJSON(w, r, logger, http.StatusOK, tagResponse(item))
			return
		}
	}
	writeError(w, r, logger, "get", err)
}

func (h *handler) create(w http.ResponseWriter, r *http.Request, p model.Principal) {
	projectID, _, logger, err := h.resource(w, r, p, false)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var name string
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "name")
		err = e
		if err == nil {
			if !jsonunicode.Valid(fields["name"]) {
				err = httpx.InvalidInput("name must contain valid Unicode text")
			} else {
				name, err = httpx.RequiredString(fields, "name")
			}
		}
	}
	if err == nil {
		var result tagservice.WriteResult
		result, err = h.operations.Create(r.Context(), p, projectID, name)
		if err == nil {
			logger = logger.With("tag_id", result.Item.Tag.ID, "tx_outcome", string(result.Outcome), "phase", result.Phase)
			logger.InfoContext(r.Context(), "tag created", "component", "tag", "request_id", httpx.RequestID(r.Context()))
			w.Header().Set("Location", "/api/v1/projects/"+projectID+"/tags/"+result.Item.Tag.ID)
			httpx.WriteMutationJSON(w, r, logger, "tag", http.StatusCreated, tagResponse(result.Item))
			return
		}
		writeMutationError(w, r, logger, "create", result, err)
		return
	}
	writeError(w, r, logger, "create", err)
}

func (h *handler) rename(w http.ResponseWriter, r *http.Request, p model.Principal) {
	projectID, tagID, logger, err := h.resource(w, r, p, true)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var version int64
	var name string
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "version", "name")
		err = e
		if err == nil {
			version, err = httpx.VersionInput(fields)
		}
		if err == nil {
			if !jsonunicode.Valid(fields["name"]) {
				err = httpx.InvalidInput("name must contain valid Unicode text")
			} else {
				name, err = httpx.RequiredString(fields, "name")
			}
		}
	}
	if err == nil {
		var result tagservice.WriteResult
		result, err = h.operations.Rename(r.Context(), p, projectID, tagID, version, name)
		if err == nil {
			logger = logger.With("tx_outcome", string(result.Outcome), "phase", result.Phase)
			logger.InfoContext(r.Context(), "tag renamed", "component", "tag", "request_id", httpx.RequestID(r.Context()))
			httpx.WriteMutationJSON(w, r, logger, "tag", http.StatusOK, tagResponse(result.Item))
			return
		}
		writeMutationError(w, r, logger, "rename", result, err)
		return
	}
	writeError(w, r, logger, "rename", err)
}

func (h *handler) delete(w http.ResponseWriter, r *http.Request, p model.Principal) {
	projectID, tagID, logger, err := h.resource(w, r, p, true)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var version int64
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "version", "confirm")
		err = e
		if err == nil {
			version, err = httpx.VersionInput(fields)
		}
		if err == nil {
			var confirm *bool
			confirm, err = httpx.OptionalBool(fields, "confirm")
			if err == nil && (confirm == nil || !*confirm) {
				err = &model.Fault{Code: "confirmation_required", Message: "Tag deletion requires explicit confirmation."}
			}
		}
	}
	if err == nil {
		var result tagservice.WriteResult
		result, err = h.operations.Delete(r.Context(), p, projectID, tagID, version, true)
		if err == nil {
			logger = logger.With("tx_outcome", string(result.Outcome), "phase", result.Phase)
			logger.InfoContext(r.Context(), "tag deleted", "component", "tag", "request_id", httpx.RequestID(r.Context()))
			httpx.WriteMutationJSON(w, r, logger, "tag", http.StatusOK, api.TagDeletionReceipt{ProjectID: result.ProjectID, TagID: result.TagID, Deleted: result.Deleted})
			return
		}
		writeMutationError(w, r, logger, "delete", result, err)
		return
	}
	writeError(w, r, logger, "delete", err)
}

func (h *handler) resolve(w http.ResponseWriter, r *http.Request, p model.Principal) {
	projectID, _, logger, err := h.resource(w, r, p, false)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var ids *[]string
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "tagIds")
		err = e
		if err == nil {
			if !jsonunicode.Valid(fields["tagIds"]) {
				err = httpx.InvalidInput("tagIds must contain valid Unicode text")
			} else {
				ids, err = httpx.OptionalStrings(fields, "tagIds")
			}
			if err == nil && ids == nil {
				err = httpx.InvalidInput("tagIds is required and must be an array of strings")
			}
		}
	}
	if err == nil {
		var refs []model.TagReference
		refs, err = h.operations.Resolve(r.Context(), p, projectID, *ids)
		if err == nil {
			var body bytes.Buffer
			_, err = tagprotocol.EncodeResolve(&body, refs)
			if err == nil {
				if r.Context().Err() != nil {
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				n, e := w.Write(body.Bytes())
				if e == nil && n != body.Len() {
					e = io.ErrShortWrite
				}
				if e != nil {
					httpx.LogFailure(logger, r.Context(), "tag", "response", e)
				}
				return
			}
			err = &model.Fault{Code: "resource_limit_exceeded", Message: "Tag resolution response exceeds its encoded resource limit.", Cause: err}
		}
	}
	writeError(w, r, logger, "resolve", err)
}

func writeMutationError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, result tagservice.WriteResult, err error) {
	logger = logger.With("tx_outcome", string(result.Outcome), "tx_phase", result.Phase, "cleanup_failed", result.CleanupFailed)
	facts := operation.CompletionFacts(err)
	if result.Outcome == store.TransactionUnknown || result.Outcome == store.TransactionCommitted || facts.Outcome == store.TransactionUnknown || facts.Outcome == store.TransactionCommitted {
		httpx.LogFailure(logger.With("write_outcome", "unknown"), r.Context(), "tag", phase, err)
		httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: "The tag write outcome is unknown.", RequestID: httpx.RequestID(r.Context())}})
		return
	}
	if result.Outcome == store.TransactionNotCommitted && !result.CleanupFailed && safeNameConflict(err) {
		httpx.LogFailure(logger, r.Context(), "tag", phase, err)
		httpx.WriteJSON(w, r, logger, http.StatusConflict, api.ErrorResponse{Error: api.Error{Code: "tag_name_conflict", Message: "A tag with this name already exists.", RequestID: httpx.RequestID(r.Context())}})
		return
	}
	if errors.Is(err, store.ErrTagNameConflict) {
		httpx.LogFailure(logger, r.Context(), "tag", phase, err)
		httpx.WriteJSON(w, r, logger, http.StatusInternalServerError, api.ErrorResponse{Error: api.Error{Code: "internal_error", Message: "internal server error", RequestID: httpx.RequestID(r.Context())}})
		return
	}
	writeError(w, r, logger, phase, err)
}

// The DAO marks only the specific unique index. A second error or unreliable
// completion must not be hidden behind that marker.
func safeNameConflict(err error) bool {
	var transactions, databases, markers int
	valid := true
	var visit func(error)
	visit = func(current error) {
		if current == nil {
			return
		}
		if current == store.ErrTagNameConflict {
			markers++
		}
		switch e := current.(type) {
		case *store.TransactionError:
			transactions++
			if e.Phase != "operation" || e.Outcome != store.TransactionNotCommitted || e.CleanupFailed || e.CommitAttempted {
				valid = false
			}
		case *store.ThreadTransactionError:
			valid = false
		case *store.Error:
			databases++
			if !e.DatabaseFailure || e.SQLState != "23505" {
				valid = false
			}
		}
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			children := joined.Unwrap()
			if len(children) != 2 || children[0] != store.ErrTagNameConflict {
				valid = false
			} else if _, ok := children[1].(*store.Error); !ok {
				valid = false
			}
			for _, child := range children {
				visit(child)
			}
		} else {
			visit(errors.Unwrap(current))
		}
	}
	visit(err)
	return valid && transactions == 1 && databases == 1 && markers == 1
}

func writeError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, err error) {
	if fault, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code {
		status := 0
		switch fault.Code {
		case "invalid_tag_name", "invalid_tag_filter", "confirmation_required":
			status = http.StatusBadRequest
		case "tag_not_found":
			status = http.StatusNotFound
		case "tag_name_conflict", "catalog_changed":
			status = http.StatusConflict
		}
		if status != 0 {
			httpx.CloseUnreadBody(w, r)
			httpx.LogFailure(logger, r.Context(), "tag", phase, err)
			httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
			return
		}
	}
	httpx.WriteError(w, r, logger, "tag", phase, err)
}
