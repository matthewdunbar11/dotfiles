--
local function jump_to_previous_buffer()
	if vim.fn.bufnr("%") == -1 and vim.fn.buflisted("$") ~= -1 then
		vim.cmd("normal! <C-^>")
	end
end

return {
	"romgrk/barbar.nvim",
	dependencies = {
		"nvim-tree/nvim-web-devicons", -- OPTIONAL: for file icons
		"lewis6991/gitsigns.nvim", -- OPTIONAL: for git status
	},
	init = function()
		vim.g.barbar_auto_hide = 0

		-- vim.api.nvim_create_autocmd("BufDelete", {
		-- 	pattern = "*",
		-- 	callback = jump_to_previous_buffer,
		-- })
	end,
	config = function()
		require("barbar").setup({
			-- your barbar configuration options here
			-- e.g., enable filetype icons, git signs, etc.
			auto_hide = false,
			animation = false,
			-- offset_labels =
			-- 	["NvimTree1"] = "File Explorer",
			-- },
		})
	end,
}
