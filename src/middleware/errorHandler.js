module.exports = (err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).send('<!doctype html><title>Error</title><h1>Request failed</h1><p>Please check the application logs.</p>');
};
