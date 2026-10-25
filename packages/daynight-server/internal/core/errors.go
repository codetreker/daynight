package core

import (
	"errors"
	"fmt"
)

var ErrNotFound = errors.New("resource not found")

var ErrTaskDeleted = fmt.Errorf("task was deleted: %w", ErrNotFound)
