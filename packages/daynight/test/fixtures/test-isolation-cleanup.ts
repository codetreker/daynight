import { testIsolation } from "../../scripts/test-bootstrap.js";

export default () => () => testIsolation.cleanup();
