/**
 * asyncHandler — обёртка для async Express controllers.
 *
 * Без неё в каждом controller пришлось бы писать:
 * try { ... } catch (error) { next(error) }
 *
 * С ней controller может просто бросить ошибку, а asyncHandler сам передаст её
 * в общий errorHandler.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };

