FROM python:3.12-slim

# h5py и numpy ставятся готовыми колёсами (manylinux), компилятор не нужен
RUN pip install --no-cache-dir h5py==3.16.0 numpy==2.4.6

WORKDIR /app
COPY server.py ./

ENV PORT=3200 PYTHONUNBUFFERED=1
EXPOSE 3200
USER nobody
CMD ["python", "server.py"]
