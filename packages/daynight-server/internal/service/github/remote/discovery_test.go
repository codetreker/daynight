package remote

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestListAllBoundedAndFollowsValidatedLinks(t *testing.T) {
	const namedPath = "/repos/a/b/pulls"
	const numericPath = "/repositories/7/pulls"
	for _, mode := range []string{"truncate", "end", "numeric_path", "wrong_repository_id", "page10_error", "cycle", "wrong_query", "page10_cycle", "page10_wrong_query", "wrong_path", "bad_query", "duplicate_param"} {
		t.Run(mode, func(t *testing.T) {
			requests := []int{}
			var base string
			c, server, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "access_tokens") {
					tokenResponse(w)
					return
				}
				q := r.URL.Query()
				if q.Get("state") != "all" || q.Get("sort") != "created" || q.Get("direction") != "desc" || q.Get("per_page") != "20" {
					t.Errorf("wrong query %v", q)
				}
				page := 1
				if q.Get("page") != "" {
					page, _ = strconv.Atoi(q.Get("page"))
				}
				requests = append(requests, page)
				wantPath := namedPath
				if mode == "numeric_path" && page > 1 {
					wantPath = numericPath
				}
				if r.URL.Path != wantPath {
					t.Errorf("page %d: path = %q, want %q", page, r.URL.Path, wantPath)
				}
				if mode == "page10_error" && page == 10 {
					http.Error(w, "failed", 500)
					return
				}
				if (mode != "numeric_path" || page == 1) && (mode != "end" || page < 10) {
					next := page + 1
					if mode == "cycle" || (mode == "page10_cycle" && page == 10) {
						next = 1
					}
					state := "all"
					if mode == "wrong_query" || (mode == "page10_wrong_query" && page == 10) {
						state = "open"
					}
					nextPath := namedPath
					switch mode {
					case "numeric_path":
						nextPath = numericPath
					case "wrong_repository_id":
						nextPath = "/repositories/8/pulls"
					case "wrong_path":
						nextPath = "/repos/other/b/pulls"
					}
					query := fmt.Sprintf("state=%s&sort=created&direction=desc&per_page=20&page=%d", state, next)
					if mode == "bad_query" {
						query += "&bad=%xx"
					}
					if mode == "duplicate_param" {
						query += "&state=all"
					}
					w.Header().Set("Link", fmt.Sprintf(`<%s%s?%s>; rel="next"`, base, nextPath, query))
				}
				fmt.Fprint(w, `[ {"number":1,"state":"closed","updated_at":"2026-01-01T00:00:00Z","closed_at":"2026-01-01T00:00:00Z","merged_at":null,"base":{"repo":{"id":7}}} ]`)
			})
			base = server.URL
			var visited int
			truncated, err := c.ListAll(context.Background(), 12, 7, "a", "b", func(page []PullSummary) error {
				visited++
				if len(page) != 1 || page[0].Number != 1 || page[0].RepositoryID != 7 {
					t.Fatalf("page %+v", page)
				}
				return nil
			})
			switch mode {
			case "truncate":
				if err != nil || !truncated || visited != 10 || len(requests) != 10 {
					t.Fatalf("truncated=%v visited=%d requests=%v err=%v", truncated, visited, requests, err)
				}
			case "end":
				if err != nil || truncated || visited != 10 || len(requests) != 10 {
					t.Fatalf("truncated=%v visited=%d requests=%v err=%v", truncated, visited, requests, err)
				}
			case "numeric_path":
				if err != nil || truncated || visited != 2 || len(requests) != 2 || requests[1] != 2 {
					t.Fatalf("truncated=%v visited=%d requests=%v err=%v", truncated, visited, requests, err)
				}
			case "page10_error":
				if err == nil || visited != 9 || len(requests) != 10 {
					t.Fatalf("visited=%d requests=%v err=%v", visited, requests, err)
				}
			case "page10_cycle", "page10_wrong_query":
				if err == nil || visited != 9 || len(requests) != 10 {
					t.Fatalf("visited=%d requests=%v err=%v", visited, requests, err)
				}
			default:
				if err == nil || visited != 0 || len(requests) != 1 {
					t.Fatalf("requests=%v err=%v", requests, err)
				}
			}
		})
	}
}

func TestDecodePullSummaryRejectsInvalidFacts(t *testing.T) {
	for _, value := range []string{
		`{"number":1,"state":"closed","updated_at":"2026-01-01T00:00:00Z","closed_at":null,"merged_at":null,"base":{"repo":{"id":7}}}`,
		`{"number":1,"state":"open","updated_at":"2026-01-01T00:00:00Z","closed_at":null,"merged_at":"2026-01-01T00:00:00Z","base":{"repo":{"id":7}}}`,
		`{"number":1,"state":"closed","updated_at":"2026-01-01T00:00:00Z","closed_at":"2026-01-01T00:00:00Z","merged_at":null,"base":{"repo":{"id":0}}}`,
	} {
		if _, err := decodePullSummary([]byte(value)); err == nil {
			t.Fatalf("accepted %s", value)
		}
	}
}
