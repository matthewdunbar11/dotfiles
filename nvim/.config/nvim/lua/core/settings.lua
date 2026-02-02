local M = {}

M.setup = function()
	-- enable experimental loader to improve performance
	vim.loader.enable()
	vim.diagnostic.config({ virtual_text = true })
	vim.o.winborder = "rounded"
end

return M
