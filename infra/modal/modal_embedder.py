import modal
from pydantic import BaseModel
from typing import List, Literal

# Define the Modal App
app = modal.App("agentmailbox-embedder")

# Define the environment: Python 3.11 with sentence-transformers
# We download the model during image build so the container starts instantly
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("sentence-transformers", "torch", "fastapi[standard]", "pydantic")
    .run_commands(
        "python -c \"from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-large-en-v1.5')\""
    )
)

class EmbeddingRequest(BaseModel):
    texts: List[str]
    mode: Literal["query", "passage"] = "passage"

class EmbeddingResponse(BaseModel):
    embeddings: List[List[float]]
    dimensions: int


@app.cls(image=image, gpu="T4", scaledown_window=300)
class Embedder:
    @modal.enter()
    def setup(self):
        """Loads the model into GPU memory when the container starts."""
        from sentence_transformers import SentenceTransformer
        print("Loading BGE model to GPU...")
        self.model = SentenceTransformer("BAAI/bge-large-en-v1.5")

    @modal.method()
    def embed(self, texts: List[str], mode: str = "passage") -> dict:
        """
        Takes a list of strings and returns their embeddings.
        bge-large-en-v1.5 produces 1024-dimensional vectors.
        """
        if mode == "query":
            prefixed = [f"query: {t}" for t in texts]
        else:
            prefixed = [f"passage: {t}" for t in texts]

        print(f"Generating {mode} embeddings for {len(prefixed)} items...")
        embeddings = self.model.encode(prefixed, normalize_embeddings=True)
        return {
            "embeddings": embeddings.tolist(),
            "dimensions": int(embeddings.shape[1]),
        }


# Expose the embed method as a FastAPI web endpoint
from fastapi import FastAPI

web_app = FastAPI(title="AgentMailbox Embedder", version="1.0.0")

@web_app.post("/embed", response_model=EmbeddingResponse)
async def embed_endpoint(req: EmbeddingRequest):
    """GPU-accelerated embedding endpoint using BGE-large-en-v1.5."""
    embedder = Embedder()
    result = embedder.embed.remote(req.texts, req.mode)
    return result


@app.function(image=image)
@modal.asgi_app()
def fastapi_app():
    return web_app
