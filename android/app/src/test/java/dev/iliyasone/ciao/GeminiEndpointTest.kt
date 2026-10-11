package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** GeminiEndpoint.parse, as parseGeminiEndpoint in src/core/gemini.ts answers the same. */
class GeminiEndpointTest {
    private fun refusal(reason: String, consumer: String) =
        """{"error":{"code":403,"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"$reason","metadata":{"consumer":"$consumer"}}]}}"""

    @Test fun aiStudioKeyGetsTheModels() = assertEquals("", GeminiEndpoint.parse(200, """{"models":[]}"""))

    @Test fun vertexKeyLimitedToVertex() =
        assertEquals("906271403959", GeminiEndpoint.parse(403, refusal("API_KEY_SERVICE_BLOCKED", "projects/906271403959")))

    @Test fun vertexKeyInProjectWithoutGeminiApi() =
        assertEquals("906271403959", GeminiEndpoint.parse(403, refusal("SERVICE_DISABLED", "projects/906271403959")))

    @Test fun malformedConsumerIsAWrongKey() = assertEquals("", GeminiEndpoint.parse(403, refusal("API_KEY_SERVICE_BLOCKED", "projects/x")))

    @Test fun wrongKey() = assertEquals("", GeminiEndpoint.parse(400, """{"error":{"code":400,"details":[{"reason":"API_KEY_INVALID"}]}}"""))

    @Test fun serverErrorIsNoAnswer() = assertNull(GeminiEndpoint.parse(503, "<html>unavailable</html>"))

    @Test fun rateLimitIsNoAnswer() = assertNull(GeminiEndpoint.parse(429, """{"error":{"code":429}}"""))

    @Test fun vertexModelPath() = assertEquals(
        "projects/1/locations/global/publishers/google/models/gemini-3.5-transcribe-live-preview",
        GeminiEndpoint.vertexModel("1", "gemini-3.5-transcribe-live"),
    )
}
