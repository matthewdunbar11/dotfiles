return {
	{
		"nvim-tree/nvim-tree.lua",
		dependencies = {
			"nvim-tree/nvim-web-devicons", -- Recommended for icons
		},
		keys = {
			{ "<leader>e", "<CMD>NvimTreeToggle<CR>", desc = "Toggle Nvim Tree" },
		},
		config = function()
			require("nvim-tree").setup({
				-- actions = {
				-- 	open_file = {
				-- 		quit_on_open = true,
				-- 	},
				-- },
				-- disable_netrw = true,
				-- git = {
				-- 	ignore = false,
				-- },
				-- hijack_directories = {
				-- 	enable = true,
				-- },
				-- update_focused_file = {
				-- 	enable = true,
				-- },
				-- view = {
				-- 	adaptive_size = true,
				-- },
				-- Add your nvim-tree configuration options here
				-- Example:
				update_focused_file = {
					enable = true,
				},
				view = {
					adaptive_size = true,
				},
				renderer = {
					icons = {
						glyphs = {
							folder = {
								arrow_open = "",
								arrow_closed = "",
							},
						},
					},
				},
				-- You can find more options in the nvim-tree documentation
			})
		end,
	},
}
